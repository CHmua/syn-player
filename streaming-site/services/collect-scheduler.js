const cron = require('node-cron');
const { getRecentUpdatesMulti, enrichWithPlayUrls, syncCategories, dedup } = require('./collect');
const { delPattern } = require('./cache');

// ============================================================
//  Auto-Collection Scheduler
//  AppleCMS multi-source sync with play URL enrichment
//  Supports MySQL (primary) and SQLite (fallback)
// ============================================================

let isCollecting = false;
let initialSyncDone = false;
let dbBackend = null; // 'mysql' | 'sqlite'
let mysqlPool = null;
let sqliteDb = null;

async function getDB() {
  if (dbBackend) return dbBackend;

  // Try MySQL first — need to actually test the connection
  try {
    mysqlPool = require('../db');
    await mysqlPool.query('SELECT 1');
    dbBackend = 'mysql';
    console.log('[Collect] Using MySQL backend');
    return 'mysql';
  } catch {
    mysqlPool = null;
    delete require.cache[require.resolve('../db')];
  }

  // Fall back to SQLite
  try {
    sqliteDb = require('../database');
    dbBackend = 'sqlite';
    console.log('[Collect] Using SQLite backend (MySQL unavailable)');
    return 'sqlite';
  } catch { /* fall through */ }

  console.error('[Collect] No database available!');
  return null;
}

// --------------- Unified query helpers ---------------

async function dbQuery(sql, params = []) {
  await getDB();
  if (dbBackend === 'mysql' && mysqlPool) {
    return mysqlPool.query(sql, params);
  }
  if (dbBackend === 'sqlite' && sqliteDb) {
    return sqliteQuery(sql, params);
  }
  throw new Error('No database');
}

// SQLite wrapper — mimics mysql2's [rows] format
function sqliteQuery(sql, params = []) {
  const db = sqliteDb;
  // Normalize MySQL ? placeholders to SQLite ?
  const sqlite = sql.replace(/\?/g, '?'); // same syntax, but keep consistent

  const upperSql = sql.trim().toUpperCase();

  if (upperSql.startsWith('SELECT') || upperSql.startsWith('WITH')) {
    // SELECT → return [rows, fields]
    const stmt = db.prepare(sql);
    const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
    return [rows];
  }

  if (upperSql.startsWith('INSERT') || upperSql.startsWith('UPDATE') || upperSql.startsWith('DELETE')) {
    // DML → return { affectedRows }
    const stmt = db.prepare(sql);
    const result = params.length > 0 ? stmt.run(...params) : stmt.run();
    return [{ affectedRows: result.changes }];
  }

  // Fallback
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return [{ affectedRows: result.changes }];
}

// --------------- Save VOD to DB ---------------
async function saveVodToDB(item) {
  try {
    const [existing] = await dbQuery('SELECT id, vod_play_url FROM vods WHERE vod_id = ?', [item.vod_id]);

    if (existing && existing.length > 0) {
      await dbQuery(
        `UPDATE vods SET
          vod_name = ?,
          vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END,
          vod_play_url = CASE WHEN ? != '' THEN ? ELSE vod_play_url END,
          vod_remarks = ?,
          vod_year = CASE WHEN ? != '' THEN ? ELSE vod_year END,
          vod_area = CASE WHEN ? != '' THEN ? ELSE vod_area END,
          vod_lang = CASE WHEN ? != '' THEN ? ELSE vod_lang END,
          vod_actor = CASE WHEN ? != '' THEN ? ELSE vod_actor END,
          vod_director = CASE WHEN ? != '' THEN ? ELSE vod_director END,
          vod_score = CASE WHEN ? != '' THEN ? ELSE vod_score END,
          vod_type = CASE WHEN ? != '' THEN ? ELSE vod_type END,
          type_name = CASE WHEN ? != '' THEN ? ELSE type_name END,
          vod_play_from = CASE WHEN ? != '' THEN ? ELSE vod_play_from END,
          source_name = CASE WHEN ? != '' THEN ? ELSE source_name END,
          updated_at = CURRENT_TIMESTAMP
        WHERE vod_id = ?`,
        [
          item.vod_name,
          item.vod_pic, item.vod_pic,
          item.vod_play_url, item.vod_play_url,
          item.vod_remarks || '',
          item.vod_year, item.vod_year,
          item.vod_area, item.vod_area,
          item.vod_lang, item.vod_lang,
          item.vod_actor, item.vod_actor,
          item.vod_director, item.vod_director,
          item.vod_score, item.vod_score,
          item.vod_type, item.vod_type,
          item.type_name, item.type_name,
          item.vod_play_from, item.vod_play_from,
          item.source_name, item.source_name,
          item.vod_id
        ]
      );
      return 'updated';
    } else {
      await dbQuery(
        `INSERT INTO vods (vod_id, vod_name, vod_pic, vod_content, vod_play_url,
          vod_remarks, vod_year, vod_area, vod_lang, vod_actor, vod_director,
          vod_score, vod_type, type_name, vod_play_from, source_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.vod_id, item.vod_name, item.vod_pic || '', item.vod_content || '',
          item.vod_play_url || '', item.vod_remarks || '', item.vod_year || '',
          item.vod_area || '', item.vod_lang || '', item.vod_actor || '',
          item.vod_director || '', item.vod_score || '0.0', item.vod_type || '',
          item.type_name || '', item.vod_play_from || '', item.source_name || ''
        ]
      );
      return 'new';
    }
  } catch (err) {
    console.error(`[Collect] DB save error for ${item.vod_id}:`, err.message);
    return 'error';
  }
}

// --------------- Collect with enrichment ---------------
async function collectRecentUpdates() {
  if (isCollecting) return;
  isCollecting = true;

  const startTime = Date.now();
  let totalFetched = 0, newAdded = 0, updatedExisting = 0, enrichedCount = 0;

  try {
    await getDB();
    if (!dbBackend) {
      console.log('[Collect] No database, skipping collection');
      return;
    }

    // Phase 1: Sync categories (first run or every 6 hours)
    try {
      const [lastLog] = await dbQuery(
        "SELECT MAX(created_at) as last_sync FROM collect_logs WHERE collect_type = 'categories' AND status = 'success'"
      );
      const lastSync = lastLog?.[0]?.last_sync;
      const needCatSync = !lastSync ||
        (Date.now() - new Date(lastSync + 'Z').getTime()) > 21600000; // 6h

      if (needCatSync) {
        console.log('[Collect] Syncing categories...');
        const cats = await syncCategories();
        const catDuration = Date.now() - startTime;
        await dbQuery(
          `INSERT INTO collect_logs (source_name, collect_type, total_fetched, new_added, updated_existing, status, duration_ms)
           VALUES (?, 'categories', ?, ?, 0, 'success', ?)`,
          ['all-sources', cats.length, cats.length, catDuration]
        );
        console.log(`[Collect] Categories synced: ${cats.length} types`);
      }
    } catch (err) {
      console.error('[Collect] Category sync error:', err.message);
    }

    // Phase 2: Fetch listings from all sources
    const pages = initialSyncDone ? 3 : 5;
    console.log(`[Collect] Fetching listings (pages 1-${pages})...`);

    const allItems = await getRecentUpdatesMulti(1, pages);
    totalFetched = allItems.length;
    console.log(`[Collect] Fetched ${totalFetched} items from all sources`);

    // Phase 3: Save to DB
    for (const item of allItems) {
      const result = await saveVodToDB(item);
      if (result === 'new') newAdded++;
      else if (result === 'updated') updatedExisting++;
    }

    // Phase 4: Enrich items without play URLs
    const [missing] = await dbQuery(
      "SELECT vod_id, source_name FROM vods WHERE is_active = 1 AND (vod_play_url IS NULL OR vod_play_url = '') AND source_name != '' LIMIT 100"
    );

    if (missing && missing.length > 0) {
      console.log(`[Collect] Enriching ${missing.length} items with play URLs...`);
      const details = await enrichWithPlayUrls(missing);

      for (const detail of details) {
        await dbQuery(
          "UPDATE vods SET vod_play_url = ?, vod_play_from = ?, vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END, updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?",
          [detail.vod_play_url, detail.vod_play_from || '', detail.vod_pic, detail.vod_pic, detail.vod_id]
        );
        enrichedCount++;
      }
    }

    // Phase 5: Cleanup cache
    await delPattern('recent:*');
    await delPattern('search:*');

    const duration = Date.now() - startTime;
    console.log(`[Collect] Done: ${totalFetched} fetched, ${newAdded} new, ${updatedExisting} updated, ${enrichedCount} enriched (${duration}ms)`);

    // Log
    await dbQuery(
      `INSERT INTO collect_logs (source_name, collect_type, total_fetched, new_added, updated_existing, status, duration_ms)
       VALUES (?, 'recent', ?, ?, ?, 'success', ?)`,
      ['all-sources', totalFetched, newAdded, updatedExisting, duration]
    );

    initialSyncDone = true;

  } catch (err) {
    const duration = Date.now() - startTime;
    console.error('[Collect] Failed:', err.message);

    try {
      await dbQuery(
        `INSERT INTO collect_logs (source_name, collect_type, total_fetched, new_added, updated_existing, status, error_msg, duration_ms)
         VALUES (?, 'recent', 0, 0, 0, 'failed', ?, ?)`,
        ['all-sources', err.message, duration]
      );
    } catch { /* */ }
  } finally {
    isCollecting = false;
  }
}

// --------------- Full deep sync ---------------
async function fullDeepSync() {
  if (isCollecting) {
    console.log('[Collect] Already collecting, skipping');
    return { skipped: true };
  }
  isCollecting = true;

  const startTime = Date.now();
  let totalFetched = 0, newAdded = 0, updatedExisting = 0, enrichedCount = 0;

  try {
    await getDB();
    if (!dbBackend) return { error: 'No database' };

    console.log('[Collect] Deep sync: fetching pages 1-20...');
    const allItems = await getRecentUpdatesMulti(1, 20);
    totalFetched = allItems.length;

    for (const item of allItems) {
      const result = await saveVodToDB(item);
      if (result === 'new') newAdded++;
      else if (result === 'updated') updatedExisting++;
    }

    const [missing] = await dbQuery(
      "SELECT vod_id, source_name FROM vods WHERE is_active = 1 AND (vod_play_url IS NULL OR vod_play_url = '') AND source_name != '' LIMIT 500"
    );

    if (missing && missing.length > 0) {
      console.log(`[Collect] Deep enrich: ${missing.length} items`);
      const details = await enrichWithPlayUrls(missing);
      for (const detail of details) {
        await dbQuery(
          "UPDATE vods SET vod_play_url = ?, vod_play_from = ?, vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END, updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?",
          [detail.vod_play_url, detail.vod_play_from || '', detail.vod_pic, detail.vod_pic, detail.vod_id]
        );
        enrichedCount++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Collect] Deep sync done: ${totalFetched} fetched, ${newAdded} new, ${updatedExisting} updated, ${enrichedCount} enriched (${duration}ms)`);

    await dbQuery(
      `INSERT INTO collect_logs (source_name, collect_type, total_fetched, new_added, updated_existing, status, duration_ms)
       VALUES (?, 'deep_sync', ?, ?, ?, 'success', ?)`,
      ['all-sources', totalFetched, newAdded, updatedExisting, duration]
    );

    return { totalFetched, newAdded, updatedExisting, enrichedCount, duration };
  } catch (err) {
    console.error('[Collect] Deep sync failed:', err.message);
    return { error: err.message };
  } finally {
    isCollecting = false;
  }
}

// --------------- Dead URL detection ---------------
async function detectDeadUrls() {
  console.log('[URL-Check] Starting dead URL detection...');

  try {
    await getDB();
    if (!dbBackend) return;

    const [urls] = await dbQuery(
      "SELECT id, play_url FROM vod_play_urls WHERE is_active = 1 AND (last_checked IS NULL OR last_checked < datetime('now', '-1 hour')) LIMIT 50"
    );

    if (!urls || urls.length === 0) {
      console.log('[URL-Check] No URLs to check');
      return;
    }

    let deadCount = 0;
    for (const row of urls) {
      const valid = await require('./collect').checkUrlValid(row.play_url);
      if (!valid) {
        await dbQuery(
          'UPDATE vod_play_urls SET is_active = 0, fail_count = fail_count + 1, last_checked = CURRENT_TIMESTAMP WHERE id = ?',
          [row.id]
        );
        deadCount++;
      } else {
        await dbQuery(
          'UPDATE vod_play_urls SET last_checked = CURRENT_TIMESTAMP WHERE id = ?',
          [row.id]
        );
      }
    }

    console.log(`[URL-Check] Checked ${urls.length} URLs, ${deadCount} dead`);
  } catch (err) {
    console.error('[URL-Check] Error:', err.message);
  }
}

// ============================================================
//  Cron Jobs
// ============================================================

function startCollectScheduler() {
  // Every 30 minutes: collect recent updates
  cron.schedule('*/30 * * * *', async () => {
    console.log('[Cron] Running auto-collect...');
    await collectRecentUpdates();
  });

  // Every 12 hours: full deep sync with enrichment
  cron.schedule('0 */12 * * *', async () => {
    console.log('[Cron] Running deep sync...');
    await fullDeepSync();
  });

  // Every 2 hours: detect dead URLs
  cron.schedule('0 */2 * * *', async () => {
    console.log('[Cron] Running dead URL check...');
    await detectDeadUrls();
  });

  // Run initial sync on startup (after 15s for DB to be ready)
  setTimeout(async () => {
    console.log('[Cron] Initial collection on startup...');
    await collectRecentUpdates();
  }, 15000);
}

// Manual trigger — runs collection and returns summary
async function runNow() {
  if (isCollecting) {
    return { status: 'already_running', message: '采集任务正在运行中，请稍后再试' };
  }
  const startTime = Date.now();
  try {
    const previous = {
      vodCount: 0,
      videoCount: 0
    };
    try {
      const sqlite = require('../database');
      previous.vodCount = (sqlite.prepare('SELECT COUNT(*) as c FROM vods').get() || {}).c || 0;
      previous.videoCount = (sqlite.prepare('SELECT COUNT(*) as c FROM videos').get() || {}).c || 0;
    } catch {}

    await collectRecentUpdates();

    const now = {
      vodCount: 0,
      videoCount: 0
    };
    try {
      const sqlite = require('../database');
      now.vodCount = (sqlite.prepare('SELECT COUNT(*) as c FROM vods').get() || {}).c || 0;
      now.videoCount = (sqlite.prepare('SELECT COUNT(*) as c FROM videos').get() || {}).c || 0;
    } catch {}

    return {
      status: 'completed',
      duration_ms: Date.now() - startTime,
      vod_before: previous.vodCount,
      vod_after: now.vodCount,
      vod_added: now.vodCount - previous.vodCount
    };
  } catch (err) {
    return { status: 'failed', error: err.message, duration_ms: Date.now() - startTime };
  }
}

module.exports = { startCollectScheduler, collectRecentUpdates, fullDeepSync, detectDeadUrls, runNow };
