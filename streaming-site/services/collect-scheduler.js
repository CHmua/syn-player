const cron = require('node-cron');
const { getRecentUpdatesMulti, enrichWithPlayUrls, syncCategories, dedup } = require('./collect');
const { delPattern } = require('./cache');

// ============================================================
//  Auto-Collection Scheduler
//  AppleCMS multi-source sync with play URL enrichment
//  + TMDB metadata + series detection + type filtering
//  Supports MySQL (primary) and SQLite (fallback)
// ============================================================

// --------------- Type filter: exclude short drama & sports ---------------
const ALLOWED_TYPE_PATTERNS = [
  /电影/, /剧$/, /剧集/, /动漫/, /动画/, /综艺/, /纪录/, /纪录片/
];
const EXCLUDED_TYPE_PATTERNS = [
  /短剧/, /体育/
];

function shouldCollect(typeName) {
  if (!typeName) return true; // no type = allow (will be categorized later)
  const t = typeName.trim();
  for (const pat of EXCLUDED_TYPE_PATTERNS) {
    if (pat.test(t)) return false;
  }
  for (const pat of ALLOWED_TYPE_PATTERNS) {
    if (pat.test(t)) return true;
  }
  return false; // unknown types: skip
}

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

// --------------- Auto-enrich VOD with TMDB metadata + series detection ---------------
async function enrichVodRecord(vodId, vodName, vodYear) {
  try {
    const updates = {};
    let enriched = false;

    // Step 1: TMDB full metadata
    try {
      const { searchMovieFull } = require('./tmdb');
      const tmdb = await searchMovieFull(vodName, vodYear);
      if (tmdb) {
        if (tmdb.poster) {
          updates.poster = tmdb.poster;
          updates.vod_pic = tmdb.poster; // also update vod_pic for image proxy
          enriched = true;
        }
        if (tmdb.backdrop) {
          updates.backdrop_url = tmdb.backdrop;
          enriched = true;
        }
        if (tmdb.year) { updates.vod_year = tmdb.year; enriched = true; }
        if (tmdb.release_date) { updates.release_date = tmdb.release_date; enriched = true; }
        if (tmdb.rating) { updates.vod_score = tmdb.rating; enriched = true; }
        if (tmdb.genre) { updates.genre = tmdb.genre; enriched = true; }
        if (tmdb.description) { updates.vod_content = tmdb.description; enriched = true; }
        if (tmdb.director) { updates.vod_director = tmdb.director; enriched = true; }
        if (tmdb.actors) { updates.vod_actor = tmdb.actors; enriched = true; }
        if (tmdb.duration) { updates.duration = tmdb.duration; enriched = true; }
        if (tmdb.tmdb_id) { updates.tmdb_id = tmdb.tmdb_id; enriched = true; }
      }
    } catch (err) {
      console.error(`[Enrich] TMDB error for ${vodId}:`, err.message);
    }

    // Step 2: Series/season detection from title
    try {
      const { detectSeriesGroups } = require('../utils/series-detect');
      const result = detectSeriesGroups([{ id: vodId, title: vodName }]);
      if (result && result.length > 0 && result[0].seriesTitle !== result[0].originalTitle) {
        updates.series_title = result[0].seriesTitle;
        updates.season_label = result[0].seasonLabel;
        enriched = true;
      }
    } catch (err) {
      // Series detection is non-critical
    }

    // Step 3: Apply updates if any enrichment happened
    if (enriched) {
      const setClauses = [];
      const values = [];
      for (const [key, val] of Object.entries(updates)) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }
      values.push(vodId);
      await dbQuery(
        `UPDATE vods SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?`,
        values
      );
      console.log(`[Enrich] ${vodId}: updated ${Object.keys(updates).join(', ')}`);
    }

    return enriched;
  } catch (err) {
    console.error(`[Enrich] Failed for ${vodId}:`, err.message);
    return false;
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
    // Filter: exclude 短剧, 体育; only keep 电影/电视剧/动漫/综艺/纪录片
    const filteredItems = allItems.filter(item => shouldCollect(item.type_name));
    const skippedCount = allItems.length - filteredItems.length;
    if (skippedCount > 0) console.log(`[Collect] Skipped ${skippedCount} excluded types (短剧/体育/unknown)`);
    totalFetched = filteredItems.length;
    console.log(`[Collect] Fetched ${totalFetched} items from all sources`);

    // Phase 3: Save to DB + enrich new items with TMDB
    let enrichQueue = [];
    for (const item of filteredItems) {
      const result = await saveVodToDB(item);
      if (result === 'new') {
        newAdded++;
        // Queue for enrichment (limit to avoid API rate limits)
        if (enrichQueue.length < 30) {
          enrichQueue.push({ vod_id: item.vod_id, vod_name: item.vod_name, vod_year: item.vod_year });
        }
      } else if (result === 'updated') updatedExisting++;
    }

    // Phase 3.5: Enrich new items with TMDB metadata + series detection
    for (const vod of enrichQueue) {
      const didEnrich = await enrichVodRecord(vod.vod_id, vod.vod_name, vod.vod_year);
      if (didEnrich) enrichedCount++;
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
    console.log(`[Collect] Done: ${totalFetched} fetched, ${newAdded} new, ${updatedExisting} updated, ${enrichedCount} TMDB-enriched (${duration}ms)`);

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
    const filteredItems = allItems.filter(item => shouldCollect(item.type_name));
    totalFetched = filteredItems.length;
    console.log(`[Collect] Deep sync: ${totalFetched} items after filtering (skipped ${allItems.length - totalFetched})`);

    let enrichQueue = [];
    for (const item of filteredItems) {
      const result = await saveVodToDB(item);
      if (result === 'new') {
        newAdded++;
        if (enrichQueue.length < 100) {
          enrichQueue.push({ vod_id: item.vod_id, vod_name: item.vod_name, vod_year: item.vod_year });
        }
      } else if (result === 'updated') updatedExisting++;
    }

    for (const vod of enrichQueue) {
      const didEnrich = await enrichVodRecord(vod.vod_id, vod.vod_name, vod.vod_year);
      if (didEnrich) enrichedCount++;
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
    console.log(`[Collect] Deep sync done: ${totalFetched} fetched, ${newAdded} new, ${updatedExisting} updated, ${enrichedCount} TMDB-enriched (${duration}ms)`);

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

// --------------- Batch series grouping ---------------
// Groups VODs into series using pattern matching + common-prefix clustering
// Handles cases like 哆啦A梦 第一季 / 哆啦A梦：大雄的月球探险记 → all under 哆啦A梦
async function groupAllSeries() {
  console.log('[Series] Running batch series grouping...');

  try {
    await getDB();
    if (!dbBackend) return { error: 'No database' };

    // Fetch all active VODs with titles
    const [allVods] = await dbQuery(
      "SELECT vod_id, vod_name FROM vods WHERE is_active = 1 AND vod_name != ''"
    );
    if (!allVods || allVods.length === 0) {
      console.log('[Series] No VODs to group');
      return { total: 0, grouped: 0 };
    }

    // Step 1: Pattern-based detection (existing logic)
    const { detectSeriesGroups } = require('../utils/series-detect');
    const assignments = detectSeriesGroups(allVods.map(v => ({ id: v.vod_id, title: v.vod_name })));

    // Build series groups from pattern matches
    const seriesGroups = new Map(); // seriesTitle → [{ vod_id, season_label }]
    const standalone = []; // { vod_id, vod_name } — no pattern match

    for (const a of assignments) {
      if (a.seriesTitle !== a.originalTitle) {
        const key = a.seriesTitle;
        if (!seriesGroups.has(key)) seriesGroups.set(key, []);
        seriesGroups.get(key).push({ vod_id: a.id, season_label: a.seasonLabel });
      } else {
        standalone.push({ vod_id: a.id, vod_name: a.originalTitle });
      }
    }

    console.log(`[Series] Pattern groups: ${seriesGroups.size} series, ${standalone.length} standalone`);

    // Step 2: Common-prefix clustering for standalone titles
    // If a standalone title starts with a known series title, add it to that series
    const seriesNames = Array.from(seriesGroups.keys());
    let prefixMatches = 0;

    for (const item of standalone) {
      const title = item.vod_name.trim();

      // Try to match against existing series titles
      let bestMatch = null;
      let bestLen = 0;

      for (const seriesName of seriesNames) {
        // Check if title starts with the series name (allowing for colon/dash separators)
        if (title === seriesName) {
          bestMatch = seriesName;
          bestLen = seriesName.length;
          break;
        }
        // Match: "哆啦A梦：xxx" or "哆啦A梦 之 xxx" or "哆啦A梦 剧场版"
        const sepPattern = new RegExp(`^${escapeRegex(seriesName)}[：: 　\\-–—··【\\[(（].+$`);
        if (sepPattern.test(title) && seriesName.length > bestLen) {
          // Don't re-match if it already looks like a season pattern
          const remaining = title.substring(seriesName.length).replace(/^[：: 　\\-–—··【\\[(（]+/, '');
          if (remaining.length > 0) {
            bestMatch = seriesName;
            bestLen = seriesName.length;
          }
        }
      }

      if (bestMatch) {
        const remaining = title.substring(bestMatch.length).replace(/^[：: 　\-–—··【\[(（]+/, '').trim();
        if (!seriesGroups.has(bestMatch)) seriesGroups.set(bestMatch, []);
        seriesGroups.get(bestMatch).push({
          vod_id: item.vod_id,
          season_label: remaining || '特别篇'
        });
        prefixMatches++;
      } else {
        // Step 3: Find new series from standalone titles that share a meaningful prefix
        // Only cluster if at least 2 standalone titles share the same prefix
        // (handled after this loop)
      }
    }

    // Step 3: Discover new groups among remaining standalones by name clustering
    const remainingStandalone = standalone.filter(
      s => !Array.from(seriesGroups.values()).some(g => g.some(m => m.vod_id === s.vod_id))
    );

    // Build prefix index: generate candidate prefixes for each standalone title
    const prefixMap = new Map(); // prefix → [{ vod_id, vod_name }]
    for (const item of remainingStandalone) {
      const title = item.vod_name.trim();
      const candidates = new Set();

      // Method 1: Split at ：or ：colon
      const colonIdx = Math.max(title.indexOf('：'), title.indexOf(':'), title.indexOf('：'));
      if (colonIdx > 0) {
        candidates.add(title.substring(0, colonIdx).trim());
      }

      // Method 2: Remove known suffixes (season/episode markers, year, etc.)
      const stripped = title
        .replace(/[：: 　]*第[一二三四五六七八九十百千\d]+[季部期册卷]$/, '')
        .replace(/[：: 　]*Season\s*\d+$/i, '')
        .replace(/[：: 　]*[（(]\d{4}[）)]$/, '')
        .replace(/[：: 　]*(剧场版|電影版|电影版|OVA|OAD|SP|特别篇|番外篇|外传|之\s*\S.*)$/, '')
        .trim();
      if (stripped !== title && stripped.length >= 2) {
        candidates.add(stripped);
      }

      // Method 3: First N chars for Chinese/Japanese titles (sliding window 2-6 chars)
      if (/^[一-鿿぀-ゟ゠-ヿa-zA-Z0-9]/.test(title)) {
        for (let len = 6; len >= 2; len--) {
          if (title.length >= len) {
            candidates.add(title.substring(0, len));
          }
        }
      }

      // Add all candidates to prefix map
      for (const prefix of candidates) {
        if (prefix.length < 2) continue;
        if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
        // Avoid duplicates within same prefix
        const existing = prefixMap.get(prefix);
        if (!existing.some(e => e.vod_id === item.vod_id)) {
          existing.push({ vod_id: item.vod_id, vod_name: title });
        }
      }
    }

    // Choose best groups: prefer longest prefixes with most members
    let newGroups = 0;
    const assignedVods = new Set(); // track already-assigned VODs

    // Sort prefix groups by: member count desc, then prefix length desc
    const sortedPrefixes = Array.from(prefixMap.entries())
      .filter(([, items]) => items.length >= 2) // need at least 2
      .sort((a, b) => {
        const countDiff = b[1].length - a[1].length;
        if (countDiff !== 0) return countDiff;
        return b[0].length - a[0].length; // longer prefix = better match
      });

    for (const [prefix, items] of sortedPrefixes) {
      if (seriesGroups.has(prefix)) continue;
      // Filter out already-assigned VODs
      const available = items.filter(item => !assignedVods.has(item.vod_id));
      if (available.length < 2) continue;

      seriesGroups.set(prefix, []);
      for (const item of available) {
        let seasonLabel = item.vod_name.substring(prefix.length).replace(/^[：: 　\-–—··【\[(（]+/, '').trim();
        if (!seasonLabel) seasonLabel = '';
        seriesGroups.get(prefix).push({ vod_id: item.vod_id, season_label: seasonLabel });
        assignedVods.add(item.vod_id);
      }
      newGroups++;
      console.log(`[Series] New group from prefix: "${prefix}" (${available.length} items)`);
    }

    console.log(`[Series] Prefix matches: ${prefixMatches}, new groups: ${newGroups}`);

    // Step 4: Apply series_title and season_label to all VODs in groups
    let totalUpdated = 0;
    for (const [seriesTitle, members] of seriesGroups) {
      if (members.length < 2 && !seriesNames.includes(seriesTitle)) continue; // skip single-member new groups

      for (const m of members) {
        await dbQuery(
          'UPDATE vods SET series_title = ?, season_label = ?, updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?',
          [seriesTitle, m.season_label || '', m.vod_id]
        );
        totalUpdated++;
      }
    }

    // Also set series_title for standalone items (self-reference for consistency)
    // Skip this — standalone items stay as is with empty series_title

    console.log(`[Series] Done: ${seriesGroups.size} series groups, ${totalUpdated} VODs updated`);
    return { total: allVods.length, series_groups: seriesGroups.size, updated: totalUpdated };

  } catch (err) {
    console.error('[Series] Grouping error:', err.message);
    return { error: err.message };
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  // Every 12 hours: full deep sync with enrichment + series grouping
  cron.schedule('0 */12 * * *', async () => {
    console.log('[Cron] Running deep sync...');
    await fullDeepSync();
    console.log('[Cron] Running series grouping...');
    await groupAllSeries();
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

module.exports = { startCollectScheduler, collectRecentUpdates, fullDeepSync, detectDeadUrls, runNow, groupAllSeries };
