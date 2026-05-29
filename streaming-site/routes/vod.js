const express = require('express');
const router = express.Router();
const pool = require('../db');
const { searchAcrossSources, getRecentUpdates, parsePlayUrls, parseWithLines, checkUrlValid, enrichWithPlayUrls } = require('../services/collect');
const { dedupVods } = require('../utils/dedup');
const cache = require('../services/cache');
const { authMiddleware } = require('../middleware/auth');
const { proxyHandler } = require('../services/m3u8-proxy');

const IMAGE_REQUEST_TIMEOUT_MS = parseInt(process.env.IMAGE_PROXY_REQUEST_TIMEOUT_MS || '5000', 10);
const IMAGE_STREAM_TIMEOUT_MS = parseInt(process.env.IMAGE_PROXY_STREAM_TIMEOUT_MS || '7000', 10);
const AUTO_DISABLE_FAIL_THRESHOLD = Math.max(2, parseInt(process.env.VOD_AUTO_DISABLE_FAIL_THRESHOLD || '4', 10) || 4);
const AUTO_DISABLE_VERIFY_SOURCE_LIMIT = Math.max(1, parseInt(process.env.VOD_AUTO_DISABLE_VERIFY_SOURCE_LIMIT || '3', 10) || 3);
const AUTO_DISABLE_VERIFY_EP_LIMIT = Math.max(1, parseInt(process.env.VOD_AUTO_DISABLE_VERIFY_EP_LIMIT || '1', 10) || 1);

// Wrap external poster URLs through image proxy to bypass hotlink/CORS/SSL issues
function proxyImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/img-proxy?') || raw.startsWith('/api/tmdb/image-proxy?')) {
    try {
      const qIndex = raw.indexOf('?');
      const params = new URLSearchParams(raw.slice(qIndex + 1));
      const upstream = params.get('url');
      if (upstream) return `/api/vod/image-proxy?url=${encodeURIComponent(upstream)}`;
      return '/api/vod/image-proxy?fallback=1';
    } catch {
      return '/api/vod/image-proxy?fallback=1';
    }
  }
  if (raw.startsWith('/api/') || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  if (raw.startsWith('//')) return `/api/vod/image-proxy?url=${encodeURIComponent('https:' + raw)}`;
  if (/^https?:\/\//i.test(raw)) return `/api/vod/image-proxy?url=${encodeURIComponent(raw)}`;
  return raw;
}

function sourceSearchTitle(raw) {
  return String(raw || '')
    .replace(/\s*\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\d]+[\u5b63\u90e8]\s*$/g, '')
    .replace(/\s*S(?:eason)?\s*\d+\s*$/i, '')
    .trim();
}

function compactTitle(raw) {
  return sourceSearchTitle(raw).replace(/\s+/g, '').toLowerCase();
}

// Unified DB helper — tries MySQL (with connection test), falls back to SQLite
let _vodDb = null;
let _playbackHealthColumnsReady = false;
async function getVODDB() {
  if (_vodDb) return _vodDb;

  // Try MySQL first — must pass a query to verify connection
  try {
    const mysqlPool = require('../db');
    await mysqlPool.query('SELECT 1');
    _vodDb = { type: 'mysql', pool: mysqlPool };
    return _vodDb;
  } catch {
    delete require.cache[require.resolve('../db')];
  }

  // Fall back to SQLite
  try {
    const sqlite = require('../database');
    _vodDb = { type: 'sqlite', sqlite };
    return _vodDb;
  } catch { /* */ }

  _vodDb = { type: 'none' };
  return _vodDb;
}

async function ensurePlaybackHealthColumns(vdb) {
  if (_playbackHealthColumnsReady || !vdb) return;
  try {
    if (vdb.type === 'mysql') {
      try { await vdb.pool.query('ALTER TABLE vods ADD COLUMN playback_fail_count INT DEFAULT 0'); } catch {}
      try { await vdb.pool.query('ALTER TABLE vods ADD COLUMN playback_last_failed_at TIMESTAMP NULL'); } catch {}
      try { await vdb.pool.query("ALTER TABLE vods ADD COLUMN playback_disable_reason VARCHAR(255) DEFAULT ''"); } catch {}
      try { await vdb.pool.query('CREATE INDEX idx_playback_fail_count ON vods(playback_fail_count)'); } catch {}
    } else if (vdb.type === 'sqlite') {
      try { vdb.sqlite.exec('ALTER TABLE vods ADD COLUMN playback_fail_count INTEGER DEFAULT 0'); } catch {}
      try { vdb.sqlite.exec("ALTER TABLE vods ADD COLUMN playback_last_failed_at TEXT DEFAULT ''"); } catch {}
      try { vdb.sqlite.exec("ALTER TABLE vods ADD COLUMN playback_disable_reason TEXT DEFAULT ''"); } catch {}
      try { vdb.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_vods_playback_fail_count ON vods(playback_fail_count)'); } catch {}
    }
  } finally {
    _playbackHealthColumnsReady = true;
  }
}

async function getVodHealthRow(vdb, vodId) {
  if (!vdb || !vodId) return null;
  if (vdb.type === 'mysql') {
    const [rows] = await vdb.pool.query(
      `SELECT vod_id, vod_play_url, vod_play_from, is_active,
              COALESCE(playback_fail_count, 0) AS playback_fail_count
       FROM vods WHERE vod_id = ? LIMIT 1`,
      [vodId]
    );
    return rows && rows.length ? rows[0] : null;
  }
  if (vdb.type === 'sqlite') {
    return vdb.sqlite.prepare(
      `SELECT vod_id, vod_play_url, vod_play_from, is_active,
              COALESCE(playback_fail_count, 0) AS playback_fail_count
       FROM vods WHERE vod_id = ? LIMIT 1`
    ).get(vodId) || null;
  }
  return null;
}

async function findVodIdByTitle(vdb, titleHint) {
  const title = String(titleHint || '').trim();
  if (!title || !vdb) return '';
  if (vdb.type === 'mysql') {
    let rows = [];
    [rows] = await vdb.pool.query(
      'SELECT vod_id FROM vods WHERE is_active = 1 AND vod_name = ? ORDER BY updated_at DESC LIMIT 1',
      [title]
    );
    if (rows && rows.length && rows[0].vod_id) return String(rows[0].vod_id);
    [rows] = await vdb.pool.query(
      'SELECT vod_id FROM vods WHERE is_active = 1 AND vod_name LIKE ? ORDER BY updated_at DESC LIMIT 1',
      [`%${title}%`]
    );
    return rows && rows.length && rows[0].vod_id ? String(rows[0].vod_id) : '';
  }
  if (vdb.type === 'sqlite') {
    let row = vdb.sqlite.prepare(
      'SELECT vod_id FROM vods WHERE is_active = 1 AND vod_name = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(title);
    if (row && row.vod_id) return String(row.vod_id);
    row = vdb.sqlite.prepare(
      'SELECT vod_id FROM vods WHERE is_active = 1 AND vod_name LIKE ? ORDER BY updated_at DESC LIMIT 1'
    ).get(`%${title}%`);
    return row && row.vod_id ? String(row.vod_id) : '';
  }
  return '';
}

async function verifyVodStillPlayable(vodRow) {
  if (!vodRow) return false;
  const sources = parseWithLines(vodRow.vod_play_url || '', vodRow.vod_play_from || '').slice(0, AUTO_DISABLE_VERIFY_SOURCE_LIMIT);
  if (!sources.length) return false;

  for (const source of sources) {
    const episodes = (source.episodes || []).slice(0, AUTO_DISABLE_VERIFY_EP_LIMIT);
    for (const ep of episodes) {
      const url = String(ep && ep.play_url ? ep.play_url : '').trim();
      if (!url) continue;
      try {
        const ok = await checkUrlValid(url);
        if (ok) return true;
      } catch {}
    }
  }
  return false;
}

async function registerPlaybackFailure(vodId, reasonText, titleHint) {
  const cleanVodId = String(vodId || '').trim();
  if (!cleanVodId) return { updated: false, auto_disabled: false, reason: 'missing_vod_id' };

  const vdb = await getVODDB();
  if (vdb.type === 'none') return { updated: false, auto_disabled: false, reason: 'db_unavailable' };
  await ensurePlaybackHealthColumns(vdb);

  const reason = String(reasonText || 'playback_failed').trim().slice(0, 120) || 'playback_failed';
  let targetVodId = cleanVodId;
  let before = await getVodHealthRow(vdb, targetVodId);
  if (!before) {
    const matchedVodId = await findVodIdByTitle(vdb, titleHint);
    if (matchedVodId) {
      targetVodId = matchedVodId;
      before = await getVodHealthRow(vdb, targetVodId);
    }
  }
  if (!before) return { updated: false, auto_disabled: false, reason: 'not_found' };

  if (vdb.type === 'mysql') {
    await vdb.pool.query(
      `UPDATE vods
       SET playback_fail_count = COALESCE(playback_fail_count, 0) + 1,
           playback_last_failed_at = CURRENT_TIMESTAMP,
           playback_disable_reason = CASE
             WHEN playback_disable_reason IS NULL OR playback_disable_reason = '' THEN ?
             ELSE playback_disable_reason
           END
       WHERE vod_id = ?`,
      [reason, targetVodId]
    );
  } else if (vdb.type === 'sqlite') {
    vdb.sqlite.prepare(
      `UPDATE vods
       SET playback_fail_count = COALESCE(playback_fail_count, 0) + 1,
           playback_last_failed_at = datetime('now','localtime'),
           playback_disable_reason = CASE
             WHEN playback_disable_reason IS NULL OR playback_disable_reason = '' THEN ?
             ELSE playback_disable_reason
           END
       WHERE vod_id = ?`
    ).run(reason, targetVodId);
  }

  const after = await getVodHealthRow(vdb, targetVodId);
  const failCount = Math.max(0, parseInt(after && after.playback_fail_count, 10) || 0);
  if (failCount < AUTO_DISABLE_FAIL_THRESHOLD) {
    await cache.del(`detail:${targetVodId}`);
    return { updated: true, auto_disabled: false, fail_count: failCount, mapped_vod_id: targetVodId };
  }

  const stillPlayable = await verifyVodStillPlayable(after);
  if (stillPlayable) {
    if (vdb.type === 'mysql') {
      await vdb.pool.query(
        `UPDATE vods
         SET playback_fail_count = GREATEST(COALESCE(playback_fail_count, 0) - 1, 0),
             playback_disable_reason = ''
         WHERE vod_id = ?`,
        [targetVodId]
      );
    } else if (vdb.type === 'sqlite') {
      vdb.sqlite.prepare(
        `UPDATE vods
         SET playback_fail_count = CASE
              WHEN COALESCE(playback_fail_count, 0) > 0 THEN playback_fail_count - 1
              ELSE 0
            END,
            playback_disable_reason = ''
         WHERE vod_id = ?`
      ).run(targetVodId);
    }
    await cache.del(`detail:${targetVodId}`);
    return { updated: true, auto_disabled: false, fail_count: Math.max(0, failCount - 1), verified_playable: true, mapped_vod_id: targetVodId };
  }

  if (vdb.type === 'mysql') {
    await vdb.pool.query(
      `UPDATE vods
       SET is_active = 0,
           playback_disable_reason = 'auto_disabled_dead_sources',
           updated_at = CURRENT_TIMESTAMP
       WHERE vod_id = ?`,
      [targetVodId]
    );
  } else if (vdb.type === 'sqlite') {
    vdb.sqlite.prepare(
      `UPDATE vods
       SET is_active = 0,
           playback_disable_reason = 'auto_disabled_dead_sources',
           updated_at = datetime('now','localtime')
       WHERE vod_id = ?`
    ).run(targetVodId);
  }

  await cache.del(`detail:${targetVodId}`);
  await cache.del('browse:recent');
  await cache.delPattern('search:*');
  return { updated: true, auto_disabled: true, fail_count: failCount, mapped_vod_id: targetVodId };
}

// ============================================================
//  VOD API Routes
//  Search → Detail → Play URL → m3u8 Proxy → Recent Updates
// ============================================================

// --------------- Search ---------------
// Flow: Cache → MySQL → External Sources → Save to MySQL → Return
router.get('/search', async (req, res) => {
  const keyword = (req.query.wd || '').trim();
  // Allow empty keyword — returns recently updated VODs (for moreRecommend fallback, browse, etc.)
  const limit = parseInt(req.query.limit) || 50;

  try {
    // 1. Check Redis/Memory cache (1 hour TTL)
    const cacheKey = keyword ? `search:${keyword}` : 'browse:recent';
    const cached = await cache.get(cacheKey);
    if (cached) {
      logSearch(keyword || '(browse)', cached.length, 'cache', req.ip);
      const proxied = cached.map(v => ({
        ...v,
        vod_pic: proxyImageUrl(v.vod_pic || v.poster || ''),
        poster_url: proxyImageUrl(v.poster || v.vod_pic || '')
      }));
      return res.json({ success: true, data: proxied, source: 'cache' });
    }

    // 2. Check local database (MySQL or SQLite)
    let localResults = [];
    try {
      const vdb = await getVODDB();
      if (vdb.type === 'mysql') {
        const query = keyword
          ? 'SELECT * FROM vods WHERE vod_name LIKE ? AND is_active = 1 ORDER BY updated_at DESC LIMIT ?'
          : 'SELECT * FROM vods WHERE is_active = 1 ORDER BY updated_at DESC LIMIT ?';
        const params = keyword ? [`%${keyword}%`, limit] : [limit];
        const [rows] = await vdb.pool.query(query, params);
        localResults = rows;
      } else if (vdb.type === 'sqlite') {
        const query = keyword
          ? 'SELECT * FROM vods WHERE vod_name LIKE ? AND is_active = 1 ORDER BY updated_at DESC LIMIT ?'
          : 'SELECT * FROM vods WHERE is_active = 1 ORDER BY updated_at DESC LIMIT ?';
        const params = keyword ? [`%${keyword}%`, limit] : [limit];
        localResults = vdb.sqlite.prepare(query).all(...params);
      }
    } catch (dbErr) {
      console.error('[VOD] DB search error:', dbErr.message);
    }

    // 3. If local results found, dedup, cache and return
    if (localResults.length > 0) {
      const deduped = dedupVods(localResults).map(v => ({
        ...v,
        vod_pic: proxyImageUrl(v.vod_pic || v.poster || ''),
        poster_url: proxyImageUrl(v.poster || v.vod_pic || '')
      }));
      await cache.set(cacheKey, deduped, 3600);
      logSearch(keyword || '(browse)', deduped.length, 'local', req.ip);
      if (keyword) await incrementHotKeyword(keyword);
      return res.json({ success: true, data: deduped, source: 'local' });
    }

    // 4. No local results — if no keyword, return empty (don't search external with no keyword)
    if (!keyword) {
      return res.json({ success: true, data: [], source: 'none', msg: '暂无影片' });
    }

    // 4. No local results — query external resource stations
    const { results } = await searchAcrossSources(keyword);

    if (results.length > 0) {
      // 5. Save to DB, proxy posters, async TMDB enrich
      await saveVodsToDB(results);
      const deduped = dedupVods(results).map(v => ({
        ...v,
        vod_pic: proxyImageUrl(v.vod_pic || ''),
        poster_url: proxyImageUrl(v.vod_pic || '')
      }));
      await cache.set(cacheKey, deduped, 3600);
      logSearch(keyword, deduped.length, 'external', req.ip);
      await incrementHotKeyword(keyword);
      enrichVodsWithDouban(results).catch(() => {});
      return res.json({ success: true, data: deduped, source: 'external' });
    }

    // 6. Nothing found — cache null (anti-penetration, short TTL)
    await cache.setNull(cacheKey, 60);
    logSearch(keyword, 0, 'none', req.ip);
    res.json({ success: true, data: [], source: 'none', msg: '未找到相关影片' });

  } catch (err) {
    console.error('[VOD] Search error:', err);
    res.status(500).json({ success: false, msg: '搜索服务异常' });
  }
});

// --------------- Video Detail ---------------
router.get('/detail/:vodId', async (req, res) => {
  const { vodId } = req.params;

  try {
    // Check cache (skip if DB record has empty play_url — needs refresh from source)
    const cacheKey = `detail:${vodId}`;
    const cached = await cache.get(cacheKey);
    if (cached && cached.vod_play_url && cached.sources && cached.sources.length > 0) {
      return res.json({ success: true, data: cached, source: 'cache' });
    }

    const { parseWithLines, fetchAppleCMSDetail, SOURCES } = require('../services/collect');

    // Check local DB
    const vdb = await getVODDB();
    let vod = null;

    if (vdb.type === 'mysql') {
      const [rows] = await vdb.pool.query('SELECT * FROM vods WHERE vod_id = ?', [vodId]);
      if (rows.length > 0) vod = rows[0];
      // Increment hit count
      try { await vdb.pool.query('UPDATE vods SET vod_hits = vod_hits + 1 WHERE vod_id = ?', [vodId]); } catch(e) {}
    } else if (vdb.type === 'sqlite') {
      vod = vdb.sqlite.prepare('SELECT * FROM vods WHERE vod_id = ?').get(vodId);
      // Increment hit count
      try { vdb.sqlite.prepare('UPDATE vods SET vod_hits = vod_hits + 1 WHERE vod_id = ?').run(vodId); } catch(e) {}
    }

    // If found in DB but missing play URLs, try refreshing from source
    // Refresh from source if missing play URLs or essential metadata
    if (vod && (!vod.vod_play_url || vod.vod_play_url === '' || !vod.vod_content || vod.vod_content === '')) {
      const sourceName = vod.source_name;
      const sourceConfig = SOURCES.find(s => s.name === sourceName);
      if (sourceConfig && sourceConfig.enabled) {
        try {
          const freshDetails = await fetchAppleCMSDetail(sourceConfig, vodId);
          if (freshDetails.length > 0) {
            const f = freshDetails[0];
            // Update DB with play URLs and all metadata
            const pu = f.vod_play_url || '';
            const pf = f.vod_play_from || '';
            const pp = f.vod_pic || '';
            const pc = f.vod_content || '';
            const pa = f.vod_actor || '';
            const pd = f.vod_director || '';
            const py = f.vod_year || '';
            const pl = f.vod_lang || '';
            const ar = f.vod_area || '';
            const ps = f.vod_score || '';
            if (vdb.type === 'mysql') {
              await vdb.pool.query(
                `UPDATE vods SET vod_play_url = ?, vod_play_from = ?,
                  vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END,
                  vod_content = CASE WHEN ? != '' THEN ? ELSE vod_content END,
                  vod_actor = CASE WHEN ? != '' THEN ? ELSE vod_actor END,
                  vod_director = CASE WHEN ? != '' THEN ? ELSE vod_director END,
                  vod_year = CASE WHEN ? != '' THEN ? ELSE vod_year END,
                  vod_lang = CASE WHEN ? != '' THEN ? ELSE vod_lang END,
                  vod_area = CASE WHEN ? != '' THEN ? ELSE vod_area END,
                  vod_score = CASE WHEN ? != '' THEN ? ELSE vod_score END,
                  updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?`,
                [pu, pf, pp, pp, pc, pc, pa, pa, pd, pd, py, py, pl, pl, ar, ar, ps, ps, vodId]
              );
            } else if (vdb.type === 'sqlite') {
              vdb.sqlite.prepare(
                `UPDATE vods SET vod_play_url = ?, vod_play_from = ?,
                  vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END,
                  vod_content = CASE WHEN ? != '' THEN ? ELSE vod_content END,
                  vod_actor = CASE WHEN ? != '' THEN ? ELSE vod_actor END,
                  vod_director = CASE WHEN ? != '' THEN ? ELSE vod_director END,
                  vod_year = CASE WHEN ? != '' THEN ? ELSE vod_year END,
                  vod_lang = CASE WHEN ? != '' THEN ? ELSE vod_lang END,
                  vod_area = CASE WHEN ? != '' THEN ? ELSE vod_area END,
                  vod_score = CASE WHEN ? != '' THEN ? ELSE vod_score END,
                  updated_at = datetime('now','localtime') WHERE vod_id = ?`
              ).run(pu, pf, pp, pp, pc, pc, pa, pa, pd, pd, py, py, pl, pl, ar, ar, ps, ps, vodId);
            }
            vod.vod_play_url = pu || vod.vod_play_url;
            vod.vod_play_from = pf || vod.vod_play_from;
            if (pp) vod.vod_pic = pp;
            if (pc) vod.vod_content = pc;
            if (pa) vod.vod_actor = pa;
            if (pd) vod.vod_director = pd;
            if (py) vod.vod_year = py;
            if (pl) vod.vod_lang = pl;
            if (ar) vod.vod_area = ar;
            if (ps) vod.vod_score = ps;
            console.log(`[VOD] Refreshed detail for ${vodId} from ${sourceName}`);
          }
        } catch (err) {
          console.error(`[VOD] Refresh detail for ${vodId} failed:`, err.message);
        }
      }
    }

    // If the stored source id is stale or empty, search enabled sources by title and attach
    // the best playable match. This keeps admin edit and player pages from dead-ending.
    if (vod && (!vod.vod_play_url || parseWithLines(vod.vod_play_url || '', vod.vod_play_from || '').length === 0) && vod.vod_name) {
      try {
        const fullTitle = vod.vod_name;
        const baseTitle = sourceSearchTitle(fullTitle);
        let results = [];
        const firstSearch = await searchAcrossSources(fullTitle);
        results = firstSearch.results || [];
        if (!results.length && baseTitle && baseTitle !== fullTitle) {
          const secondSearch = await searchAcrossSources(baseTitle);
          results = secondSearch.results || [];
        }

        if (results.length) {
          const fullKey = compactTitle(fullTitle);
          const baseKey = compactTitle(baseTitle);
          const scored = results.map(item => {
            const itemKey = compactTitle(item.vod_name || '');
            let score = 0;
            if (itemKey === fullKey) score += 500;
            if (baseKey && itemKey === baseKey) score += 300;
            if (itemKey.includes(fullKey) || fullKey.includes(itemKey)) score += 160;
            if (baseKey && (itemKey.includes(baseKey) || baseKey.includes(itemKey))) score += 120;
            if (item.vod_year && vod.vod_year && String(item.vod_year) === String(vod.vod_year)) score += 60;
            if (item.vod_play_url) score += 40;
            return { ...item, _score: score };
          }).sort((a, b) => b._score - a._score);

          const enriched = await enrichWithPlayUrls(scored.slice(0, 5));
          const playable = enriched.find(item => item && item.vod_play_url);
          if (playable) {
            const pu = playable.vod_play_url || '';
            const pf = playable.vod_play_from || '';
            const pp = playable.vod_pic || '';
            const pc = playable.vod_content || '';
            const pa = playable.vod_actor || '';
            const pd = playable.vod_director || '';
            const py = playable.vod_year || '';
            const pl = playable.vod_lang || '';
            const ar = playable.vod_area || '';
            const ps = playable.vod_score || '';
            const pt = playable.vod_type || '';
            const tn = playable.type_name || '';
            const sn = playable.source_name || vod.source_name || '';

            if (vdb.type === 'mysql') {
              await vdb.pool.query(
                `UPDATE vods SET vod_play_url = ?, vod_play_from = ?,
                  vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END,
                  vod_content = CASE WHEN ? != '' THEN ? ELSE vod_content END,
                  vod_actor = CASE WHEN ? != '' THEN ? ELSE vod_actor END,
                  vod_director = CASE WHEN ? != '' THEN ? ELSE vod_director END,
                  vod_year = CASE WHEN ? != '' THEN ? ELSE vod_year END,
                  vod_lang = CASE WHEN ? != '' THEN ? ELSE vod_lang END,
                  vod_area = CASE WHEN ? != '' THEN ? ELSE vod_area END,
                  vod_score = CASE WHEN ? != '' THEN ? ELSE vod_score END,
                  vod_type = CASE WHEN ? != '' THEN ? ELSE vod_type END,
                  type_name = CASE WHEN ? != '' THEN ? ELSE type_name END,
                  source_name = CASE WHEN ? != '' THEN ? ELSE source_name END,
                  updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?`,
                [pu, pf, pp, pp, pc, pc, pa, pa, pd, pd, py, py, pl, pl, ar, ar, ps, ps, pt, pt, tn, tn, sn, sn, vodId]
              );
            } else if (vdb.type === 'sqlite') {
              vdb.sqlite.prepare(
                `UPDATE vods SET vod_play_url = ?, vod_play_from = ?,
                  vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END,
                  vod_content = CASE WHEN ? != '' THEN ? ELSE vod_content END,
                  vod_actor = CASE WHEN ? != '' THEN ? ELSE vod_actor END,
                  vod_director = CASE WHEN ? != '' THEN ? ELSE vod_director END,
                  vod_year = CASE WHEN ? != '' THEN ? ELSE vod_year END,
                  vod_lang = CASE WHEN ? != '' THEN ? ELSE vod_lang END,
                  vod_area = CASE WHEN ? != '' THEN ? ELSE vod_area END,
                  vod_score = CASE WHEN ? != '' THEN ? ELSE vod_score END,
                  vod_type = CASE WHEN ? != '' THEN ? ELSE vod_type END,
                  type_name = CASE WHEN ? != '' THEN ? ELSE type_name END,
                  source_name = CASE WHEN ? != '' THEN ? ELSE source_name END,
                  updated_at = datetime('now','localtime') WHERE vod_id = ?`
              ).run(pu, pf, pp, pp, pc, pc, pa, pa, pd, pd, py, py, pl, pl, ar, ar, ps, ps, pt, pt, tn, tn, sn, sn, vodId);
            }

            vod.vod_play_url = pu || vod.vod_play_url;
            vod.vod_play_from = pf || vod.vod_play_from;
            if (pp) vod.vod_pic = pp;
            if (pc) vod.vod_content = pc;
            if (pa) vod.vod_actor = pa;
            if (pd) vod.vod_director = pd;
            if (py) vod.vod_year = py;
            if (pl) vod.vod_lang = pl;
            if (ar) vod.vod_area = ar;
            if (ps) vod.vod_score = ps;
            if (pt) vod.vod_type = pt;
            if (tn) vod.type_name = tn;
            if (sn) vod.source_name = sn;
            console.log(`[VOD] Fallback source attached for ${vodId} from ${sn || 'search'}`);
          }
        }
      } catch (err) {
        console.error(`[VOD] Fallback source search for ${vodId} failed:`, err.message);
      }
    }

    if (vod) {
      // Cross-source enrichment: find same title from other sources
      const title = vod.vod_name;
      let crossSources = [];
      try {
        let crossRows = [];
        if (vdb.type === 'mysql') {
          const [rows] = await vdb.pool.query(
            "SELECT * FROM vods WHERE vod_name = ? AND vod_id != ? AND is_active = 1 AND vod_play_url != ''",
            [title, vodId]
          );
          crossRows = rows;
        } else if (vdb.type === 'sqlite') {
          crossRows = vdb.sqlite.prepare(
            "SELECT * FROM vods WHERE vod_name = ? AND vod_id != ? AND is_active = 1 AND vod_play_url != ''"
          ).all(title, vodId);
        }
        crossSources = crossRows.map(r => ({
          source_name: r.source_name,
          vod_play_url: r.vod_play_url || '',
          vod_play_from: r.vod_play_from || ''
        }));
      } catch (err) { /* ignore cross-source errors */ }

      // Parse primary source
      const primarySources = parseWithLines(vod.vod_play_url || '', vod.vod_play_from || '');

      // Parse and merge cross sources (avoid duplicate source names)
      const seenSources = new Set(primarySources.map(s => s.source_name));
      for (const cs of crossSources) {
        if (seenSources.has(cs.source_name)) continue;
        const parsed = parseWithLines(cs.vod_play_url, cs.vod_play_from);
        for (const ps of parsed) {
          if (!seenSources.has(ps.source_name) && ps.episodes.length > 0) {
            primarySources.push(ps);
            seenSources.add(ps.source_name);
          }
        }
      }

      vod.sources = primarySources;
      vod.episodes = [];
      for (const src of vod.sources) {
        for (const ep of src.episodes) {
          vod.episodes.push({ ...ep, source_name: src.source_name });
        }
      }
      // Attach both raw and proxied image URLs for admin editing and public display.
      vod.raw_poster_url = vod.poster || vod.vod_pic || '';
      vod.poster_url = proxyImageUrl(vod.raw_poster_url);
      vod.raw_backdrop_url = vod.backdrop_url || vod.backdrop || '';
      vod.backdrop_url = proxyImageUrl(vod.raw_backdrop_url);
      await cache.set(cacheKey, vod, 1800);
      return res.json({ success: true, data: vod, source: 'local' });
    }

    return res.status(404).json({ success: false, msg: '影片不存在' });
  } catch (err) {
    console.error('[VOD] Detail error:', err);
    res.status(500).json({ success: false, msg: '获取详情失败' });
  }
});

// --------------- Parse Play URL — flat episode list (backward compat) ---------------
router.get('/parse-play', (req, res) => {
  const playUrl = req.query.url || '';
  const playFrom = req.query.from || '';
  if (!playUrl) return res.json({ success: false, msg: 'Missing url' });

  const episodes = parsePlayUrls(playUrl, playFrom);
  res.json({ success: true, episodes });
});

// --------------- Parse Sources — full structured output with lines ---------------
router.get('/parse-sources', (req, res) => {
  const playUrl = req.query.url || '';
  const playFrom = req.query.from || '';
  if (!playUrl) return res.json({ success: false, msg: 'Missing url' });

  const { parseWithLines } = require('../services/collect');
  const sources = parseWithLines(playUrl, playFrom);

  // Add type detection (no proxy — client connects directly)
  for (const source of sources) {
    source.source_code = source.source_name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 6) || 'line';
  }

  res.json({
    success: true,
    sources,
    total_sources: sources.length,
    total_episodes: sources.reduce((sum, s) => sum + s.episodes.length, 0)
  });
});

// --------------- m3u8/segment proxy (CORS + referer bypass) ---------------
router.get('/m3u8-proxy', async (req, res) => {
  try {
    await proxyHandler(req, res);
  } catch (err) {
    console.error('[VOD] m3u8 proxy error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Proxy failed' });
    }
  }
});

// --------------- Check source line health ---------------
router.get('/source-health', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.json({ success: false, msg: 'Missing url' });

  const startTime = Date.now();
  const valid = await checkUrlValid(url);
  const latency = Date.now() - startTime;

  res.json({
    success: true,
    url,
    valid,
    latency_ms: latency,
    status: valid ? (latency > 3000 ? 'slow' : 'ok') : 'dead'
  });
});

// --------------- Image Proxy (poster/CORS/SSL bypass) ---------------
// Proxies external poster images to bypass hotlink protection, SSL errors, and CORS
router.get('/image-proxy', (req, res) => {
  const imgUrl = req.query.url;
  // Return placeholder when no URL or explicit fallback requested
  if (!imgUrl || req.query.fallback === '1' || (!imgUrl.startsWith('http://') && !imgUrl.startsWith('https://'))) {
    return sendPlaceholder(res);
  }

  let parsed;
  try {
    parsed = new URL(imgUrl);
  } catch {
    return sendPlaceholder(res);
  }
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? require('https') : require('http');

  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': parsed.origin + '/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    rejectUnauthorized: false,
    timeout: IMAGE_REQUEST_TIMEOUT_MS
  };

  const reqImg = transport.get(imgUrl, opts, (imgRes) => {
    // Follow redirects (up to 3)
    if ([301, 302, 303, 307, 308].includes(imgRes.statusCode)) {
      const redirectUrl = imgRes.headers.location;
      if (redirectUrl) {
        let redirectParsed;
        try {
          redirectParsed = new URL(redirectUrl, imgUrl);
        } catch {
          return sendPlaceholder(res);
        }
        const redirectTransport = redirectParsed.protocol === 'https:' ? require('https') : require('http');
        // Use redirect target origin as Referer to reduce hotlink failures on cross-origin redirects.
        opts.headers.Referer = redirectParsed.origin + '/';
        const redirectReq = redirectTransport.get(redirectParsed.href, opts, (redirectRes) => {
          pipeImageResponse(redirectRes, res);
        });
        attachProxyTimeout(redirectReq, res);
        redirectReq.on('error', () => { if (!res.headersSent) sendPlaceholder(res); });
        return;
      }
    }
    pipeImageResponse(imgRes, res);
  });
  attachProxyTimeout(reqImg, res);
  reqImg.on('error', (err) => {
    if (!res.headersSent) sendPlaceholder(res);
  });
});

function attachProxyTimeout(request, res) {
  request.setTimeout(IMAGE_REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) sendPlaceholder(res);
    request.destroy();
  });
}

function pipeImageResponse(source, dest) {
  if (source.statusCode !== 200) {
    return sendPlaceholder(dest);
  }
  source.setTimeout(IMAGE_STREAM_TIMEOUT_MS, () => {
    source.destroy();
    if (!dest.headersSent) sendPlaceholder(dest);
    else dest.end();
  });
  const contentType = source.headers['content-type'] || 'image/jpeg';
  dest.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*'
  });
  source.pipe(dest);
  source.on('error', () => { if (!dest.headersSent) sendPlaceholder(dest); });
}

// SVG placeholder: dark gradient with film reel icon
function sendPlaceholder(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="100%" style="stop-color:#16213e"/></linearGradient></defs>
    <rect width="400" height="600" fill="url(#bg)"/>
    <rect x="80" y="180" width="240" height="200" rx="8" fill="none" stroke="#333" stroke-width="2"/>
    <polygon points="175,240 175,320 260,280" fill="#444"/>
    <text x="200" y="430" text-anchor="middle" fill="#555" font-size="14" font-family="sans-serif">暂无封面</text>
  </svg>`;
  res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
  res.send(Buffer.from(svg));
}

// --------------- Check URL validity ---------------
router.get('/check-url', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.json({ success: false, msg: 'Missing url' });
  const valid = await checkUrlValid(url);
  res.json({ success: true, valid });
});

// --------------- Report playback failure (auto mark / auto disable dead VODs) ---------------
router.post('/report-playback-failure', async (req, res) => {
  try {
    const vodId = String(req.body && (req.body.vod_id || req.body.video_id) || '').trim();
    if (!vodId) return res.status(400).json({ success: false, msg: 'Missing vod_id' });

    const reason = req.body && req.body.reason ? String(req.body.reason) : 'playback_failed';
    const titleHint = req.body && req.body.title ? String(req.body.title) : '';
    const result = await registerPlaybackFailure(vodId, reason, titleHint);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[VOD] report-playback-failure error:', err.message);
    res.status(500).json({ success: false, msg: 'report failed' });
  }
});

// --------------- Recent Updates ---------------
router.get('/recent', async (req, res) => {
  const page = parseInt(req.query.pg) || 1;

  try {
    const cacheKey = `recent:${page}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, data: cached, source: 'cache' });

    // Get from external sources
    const results = await getRecentUpdates(page);
    if (results.length > 0) {
      await saveVodsToDB(results);
      const deduped = dedupVods(results);
      await cache.set(cacheKey, deduped, 600); // 10 min
      return res.json({ success: true, data: deduped, source: 'external', page });
    }

    // Fallback: latest from local DB
    const vdb = await getVODDB();
    let rows;
    if (vdb.type === 'mysql') {
      [rows] = await vdb.pool.query(
        'SELECT * FROM vods WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 50'
      );
    } else if (vdb.type === 'sqlite') {
      rows = vdb.sqlite.prepare(
        'SELECT * FROM vods WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 50'
      ).all();
    }
    const deduped = dedupVods(rows);
    await cache.set(cacheKey, deduped, 600);
    res.json({ success: true, data: deduped, source: 'local', page });

  } catch (err) {
    console.error('[VOD] Recent error:', err);
    res.status(500).json({ success: false, msg: '获取更新失败' });
  }
});

// --------------- Hot Keywords ---------------
router.get('/hot-keywords', async (req, res) => {
  try {
    const cacheKey = 'hot_keywords';
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    const vdb = await getVODDB();
    let rows = [];
    if (vdb.type === 'mysql') {
      [rows] = await vdb.pool.query(
        'SELECT keyword, search_count FROM hot_keywords ORDER BY search_count DESC LIMIT 10'
      );
    } else if (vdb.type === 'sqlite') {
      try {
        rows = vdb.sqlite.prepare(
          'SELECT keyword, search_count FROM hot_keywords ORDER BY search_count DESC LIMIT 10'
        ).all();
      } catch { rows = []; }
    }
    await cache.set(cacheKey, rows, 300);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// ============================================================
//  Helper functions
// ============================================================

async function saveVodsToDB(items) {
  if (!items || items.length === 0) return;
  const vdb = await getVODDB();

  if (vdb.type === 'mysql') {
    const conn = await vdb.pool.getConnection();
    try {
      for (const item of items) {
        await conn.query(`
          INSERT INTO vods (vod_id, vod_name, vod_pic, vod_content, vod_play_url, vod_remarks, vod_year, vod_area, vod_lang, vod_actor, vod_director, vod_score, vod_type, type_name, source_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            vod_play_url = IF(VALUES(vod_play_url) != '' AND VALUES(vod_play_url) IS NOT NULL, VALUES(vod_play_url), vod_play_url),
            vod_pic = IF(VALUES(vod_pic) != '' AND VALUES(vod_pic) IS NOT NULL, VALUES(vod_pic), vod_pic),
            updated_at = CURRENT_TIMESTAMP
        `, [
          item.vod_id, item.vod_name, item.vod_pic, item.vod_content,
          item.vod_play_url, item.vod_remarks, item.vod_year, item.vod_area,
          item.vod_lang, item.vod_actor, item.vod_director, item.vod_score,
          item.vod_type, item.type_name, item.source_name
        ]);
      }
    } finally {
      conn.release();
    }
  } else if (vdb.type === 'sqlite') {
    const insert = vdb.sqlite.prepare(`
      INSERT OR IGNORE INTO vods (vod_id, vod_name, vod_pic, vod_content, vod_play_url, vod_remarks, vod_year, vod_area, vod_lang, vod_actor, vod_director, vod_score, vod_type, type_name, source_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = vdb.sqlite.prepare(`
      UPDATE vods SET vod_play_url = CASE WHEN ? != '' THEN ? ELSE vod_play_url END,
        vod_pic = CASE WHEN ? != '' THEN ? ELSE vod_pic END,
        updated_at = CURRENT_TIMESTAMP
      WHERE vod_id = ?
    `);
    const insertMany = vdb.sqlite.transaction((rows) => {
      for (const item of rows) {
        const result = insert.run(
          item.vod_id, item.vod_name, item.vod_pic || '', item.vod_content || '',
          item.vod_play_url || '', item.vod_remarks || '', item.vod_year || '',
          item.vod_area || '', item.vod_lang || '', item.vod_actor || '',
          item.vod_director || '', item.vod_score || '0.0', item.vod_type || '',
          item.type_name || '', item.source_name || ''
        );
        if (result.changes === 0) {
          // Already exists, update play URL and poster
          update.run(item.vod_play_url || '', item.vod_play_url || '',
            item.vod_pic || '', item.vod_pic || '', item.vod_id);
        }
      }
    });
    insertMany(items);
  }
}

async function logSearch(keyword, resultCount, source, ip) {
  try {
    const vdb = await getVODDB();
    if (vdb.type === 'mysql') {
      await vdb.pool.query(
        'INSERT INTO search_logs (keyword, result_count, source, ip) VALUES (?, ?, ?, ?)',
        [keyword, resultCount, source, ip || '']
      );
    } else if (vdb.type === 'sqlite') {
      vdb.sqlite.prepare(
        'INSERT INTO search_logs (keyword, result_count, source, ip) VALUES (?, ?, ?, ?)'
      ).run(keyword, resultCount, source, ip || '');
    }
  } catch { /* non-critical */ }
}

async function incrementHotKeyword(keyword) {
  try {
    const vdb = await getVODDB();
    if (vdb.type === 'mysql') {
      await vdb.pool.query(
        'INSERT INTO hot_keywords (keyword, search_count) VALUES (?, 1) ON DUPLICATE KEY UPDATE search_count = search_count + 1',
        [keyword]
      );
    } else if (vdb.type === 'sqlite') {
      vdb.sqlite.prepare(
        'INSERT INTO hot_keywords (keyword, search_count) VALUES (?, 1) ON CONFLICT(keyword) DO UPDATE SET search_count = search_count + 1'
      ).run(keyword);
    }
  } catch { /* non-critical */ }
}

// ============================================================
//  Sync / Collection Routes (admin-only)
// ============================================================

const { collectRecentUpdates, fullDeepSync } = require('../services/collect-scheduler');

// Trigger manual sync
router.post('/sync', authMiddleware, async (req, res) => {
  const type = req.body.type || 'recent'; // recent | deep

  try {
    if (type === 'deep') {
      const result = await fullDeepSync();
      return res.json({ success: true, type: 'deep', ...result });
    } else {
      // Run in background, return immediately
      res.json({ success: true, type: 'recent', msg: '同步任务已启动，请查看日志' });
      collectRecentUpdates().catch(err => console.error('[Sync] Background error:', err.message));
    }
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Get sync status and logs
router.get('/sync-logs', async (req, res) => {
  try {
    const db = await getVODDB();
    let logs = [], vods = [{ total: 0 }], withUrl = [{ cnt: 0 }], lastUpdate = [{ ts: null }];

    if (db.type === 'mysql') {
      [logs] = await db.pool.query('SELECT * FROM collect_logs ORDER BY created_at DESC LIMIT 20');
      [vods] = await db.pool.query('SELECT COUNT(*) as total FROM vods WHERE is_active = 1');
      [withUrl] = await db.pool.query("SELECT COUNT(*) as cnt FROM vods WHERE is_active = 1 AND vod_play_url IS NOT NULL AND vod_play_url != ''");
      [lastUpdate] = await db.pool.query('SELECT MAX(updated_at) as ts FROM vods');
    } else if (db.type === 'sqlite') {
      logs = db.sqlite.prepare('SELECT * FROM collect_logs ORDER BY created_at DESC LIMIT 20').all();
      vods = [db.sqlite.prepare('SELECT COUNT(*) as total FROM vods WHERE is_active = 1').get()];
      withUrl = [db.sqlite.prepare("SELECT COUNT(*) as cnt FROM vods WHERE is_active = 1 AND vod_play_url IS NOT NULL AND vod_play_url != ''").get()];
      lastUpdate = [db.sqlite.prepare('SELECT MAX(updated_at) as ts FROM vods').get()];
    }

    res.json({
      success: true,
      stats: {
        total_vods: vods[0]?.total || 0,
        with_play_url: withUrl[0]?.cnt || 0,
        last_update: lastUpdate[0]?.ts || null
      },
      recent_logs: logs
    });
  } catch (err) {
    res.json({ success: true, stats: { total_vods: 0, with_play_url: 0 }, recent_logs: [] });
  }
});

// Get source status
router.get('/sources', (req, res) => {
  const { SOURCES } = require('../services/collect');
  res.json({
    success: true,
    sources: SOURCES.map(s => ({
      name: s.name,
      label: s.label,
      enabled: s.enabled,
      baseUrl: s.baseUrl
    }))
  });
});

// Async Douban poster enrichment for VOD records (fire-and-forget)
async function enrichVodsWithDouban(vods) {
  if (!vods || vods.length === 0) return;
  try {
    const { enrichVods } = require('../services/douban');
    const enriched = await enrichVods(vods.slice(0, 10)); // limit to 10 to avoid rate limiting
    for (const v of enriched) {
      if (!v.poster) continue;
      try {
        const vdb = await getVODDB();
        if (vdb.type === 'mysql') {
          await vdb.pool.query('UPDATE vods SET poster = ? WHERE vod_id = ?', [v.poster, v.vod_id]);
        } else if (vdb.type === 'sqlite') {
          vdb.sqlite.prepare('UPDATE vods SET poster = ? WHERE vod_id = ?').run(v.poster, v.vod_id);
        }
      } catch {}
    }
  } catch {}
}

// Related videos by type/genre for player page sidebar
router.get('/related/:vodId', async (req, res) => {
  try {
    const { vodId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 8, 20);
    const vdb = await getVODDB();

    let rows;
    if (vdb.type === 'mysql') {
      // Get the type of the current VOD, then find others of the same type
      const [current] = await vdb.pool.query('SELECT type_name, vod_type FROM vods WHERE vod_id = ?', [vodId]);
      if (current && current.length > 0) {
        const typeName = current[0].type_name || current[0].vod_type || '';
        if (typeName) {
          [rows] = await vdb.pool.query(
            'SELECT vod_id, vod_name, vod_pic, poster, vod_remarks, vod_score FROM vods WHERE vod_id != ? AND (type_name = ? OR vod_type = ?) ORDER BY updated_at DESC LIMIT ?',
            [vodId, typeName, typeName, limit]
          );
        }
      }
      if (!rows || rows.length === 0) {
        [rows] = await vdb.pool.query(
          'SELECT vod_id, vod_name, vod_pic, poster, vod_remarks, vod_score FROM vods WHERE vod_id != ? ORDER BY updated_at DESC LIMIT ?',
          [vodId, limit]
        );
      }
    } else {
      const current = vdb.sqlite.prepare('SELECT type_name, vod_type FROM vods WHERE vod_id = ?').get(vodId);
      if (current) {
        const typeName = current.type_name || current.vod_type || '';
        if (typeName) {
          rows = vdb.sqlite.prepare(
            'SELECT vod_id, vod_name, vod_pic, poster, vod_remarks, vod_score FROM vods WHERE vod_id != ? AND (type_name = ? OR vod_type = ?) ORDER BY updated_at DESC LIMIT ?'
          ).all(vodId, typeName, typeName, limit);
        }
      }
      if (!rows || rows.length === 0) {
        rows = vdb.sqlite.prepare(
          'SELECT vod_id, vod_name, vod_pic, poster, vod_remarks, vod_score FROM vods WHERE vod_id != ? ORDER BY updated_at DESC LIMIT ?'
        ).all(vodId, limit);
      }
    }

    const result = (rows || []).map(r => ({
      vod_id: r.vod_id,
      vod_name: r.vod_name,
      vod_pic: proxyImageUrl(r.poster || r.vod_pic),
      poster_url: proxyImageUrl(r.poster || r.vod_pic),
      vod_remarks: r.vod_remarks || '',
      vod_score: r.vod_score || ''
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Related VODs error:', err);
    res.json({ success: true, data: [] });
  }
});

module.exports = router;
