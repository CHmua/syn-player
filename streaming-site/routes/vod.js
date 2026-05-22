const express = require('express');
const router = express.Router();
const pool = require('../db');
const { searchAcrossSources, getRecentUpdates, parsePlayUrls, checkUrlValid } = require('../services/collect');
const { proxyHandler } = require('../services/m3u8-proxy');
const { dedupVods } = require('../utils/dedup');
const cache = require('../services/cache');
const { authMiddleware } = require('../middleware/auth');

// Unified DB helper — tries MySQL (with connection test), falls back to SQLite
let _vodDb = null;
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

// ============================================================
//  VOD API Routes
//  Search → Detail → Play URL → m3u8 Proxy → Recent Updates
// ============================================================

// --------------- Search ---------------
// Flow: Cache → MySQL → External Sources → Save to MySQL → Return
router.get('/search', async (req, res) => {
  const keyword = (req.query.wd || '').trim();
  if (!keyword) return res.json({ success: false, msg: '请输入搜索关键词' });

  try {
    // 1. Check Redis/Memory cache (1 hour TTL)
    const cacheKey = `search:${keyword}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      // Log search
      logSearch(keyword, cached.length, 'cache', req.ip);
      return res.json({ success: true, data: cached, source: 'cache' });
    }

    // 2. Check local database (MySQL or SQLite)
    let localResults = [];
    try {
      const vdb = await getVODDB();
      if (vdb.type === 'mysql') {
        const [rows] = await vdb.pool.query(
          'SELECT * FROM vods WHERE vod_name LIKE ? AND is_active = 1 LIMIT 50',
          [`%${keyword}%`]
        );
        localResults = rows;
      } else if (vdb.type === 'sqlite') {
        localResults = vdb.sqlite.prepare(
          'SELECT * FROM vods WHERE vod_name LIKE ? AND is_active = 1 LIMIT 50'
        ).all(`%${keyword}%`);
      }
    } catch (dbErr) {
      console.error('[VOD] DB search error:', dbErr.message);
    }

    // 3. If local results found, dedup, cache and return
    if (localResults.length > 0) {
      const deduped = dedupVods(localResults);
      await cache.set(cacheKey, deduped, 3600);
      logSearch(keyword, deduped.length, 'local', req.ip);
      await incrementHotKeyword(keyword);
      return res.json({ success: true, data: deduped, source: 'local' });
    }

    // 4. No local results — query external resource stations
    const { results } = await searchAcrossSources(keyword);

    if (results.length > 0) {
      // 5. Save to MySQL (INSERT IGNORE for dedup)
      await saveVodsToDB(results);
      const deduped = dedupVods(results);
      await cache.set(cacheKey, deduped, 3600);
      logSearch(keyword, deduped.length, 'external', req.ip);
      await incrementHotKeyword(keyword);
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
    // Check cache
    const cacheKey = `detail:${vodId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, data: cached, source: 'cache' });

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

  // Add proxy URLs and type detection
  for (const source of sources) {
    source.source_code = source.source_name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 6) || 'line';
    for (const ep of source.episodes) {
      ep.proxy_url = '/api/vod/m3u8-proxy?url=' + encodeURIComponent(ep.play_url);
    }
  }

  res.json({
    success: true,
    sources,
    total_sources: sources.length,
    total_episodes: sources.reduce((sum, s) => sum + s.episodes.length, 0)
  });
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

// --------------- m3u8 Proxy (core streaming) ---------------
// Proxies: .m3u8 playlists, .ts segments, .key files
// Rewrites internal links, spoofs Referer/UA, handles CORS
router.get('/m3u8-proxy', proxyHandler);

// --------------- Check URL validity ---------------
router.get('/check-url', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.json({ success: false, msg: 'Missing url' });
  const valid = await checkUrlValid(url);
  res.json({ success: true, valid });
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
//  Soupian.pro (搜片.com) routes
// ============================================================

// Direct soupian search — returns metadata + external playback links
router.get('/soupian/search', async (req, res) => {
  const keyword = (req.query.wd || '').trim();
  if (!keyword) return res.json({ success: false, msg: 'Missing keyword' });

  try {
    const { fetchSoupianSearch } = require('../services/collect');
    const results = await fetchSoupianSearch(keyword);
    res.json({ success: true, data: results, total: results.length, source: 'soupian' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Pipeline: soupian detail → scrape external AppleCMS playback pages → extract m3u8
router.get('/soupian/enrich/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name || '');
  if (!name) return res.json({ success: false, msg: 'Missing name' });

  try {
    const { getSoupianDetailForName } = require('../services/collect');
    const detail = await getSoupianDetailForName(name);
    if (!detail || detail.total_sources === 0) {
      return res.json({ success: false, msg: 'Not found on soupian' });
    }

    // Run Playwright pipeline to extract m3u8 from external sites
    const { enrichSoupianWithStreams } = require('../services/soupian-parser');
    const maxSites = parseInt(req.query.max) || 3;
    const enriched = await enrichSoupianWithStreams(detail, { maxSites });

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Soupian detail — external source links for a movie name
router.get('/soupian/detail/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name || '');
  if (!name) return res.json({ success: false, msg: 'Missing name' });

  try {
    const { getSoupianDetailForName } = require('../services/collect');
    const detail = await getSoupianDetailForName(name);
    if (detail) {
      return res.json({ success: true, data: detail });
    }
    res.json({ success: false, msg: 'Not found' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ============================================================
//  HTML / Playwright scraping routes (admin-only)
// ============================================================

// Scrape a HTML source's detail page for m3u8/mp4 URLs
router.post('/scrape-detail', authMiddleware, async (req, res) => {
  const { url, source } = req.body;
  if (!url) return res.json({ success: false, msg: 'Missing url' });

  try {
    const { getHTMLDetailPage } = require('../services/collect');
    const result = await getHTMLDetailPage(url, source || 'manual');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Manual trigger: run HTML source collection (Playwright)
router.post('/collect-html', authMiddleware, async (req, res) => {
  try {
    const { collectHTMLSources } = require('../services/collect-scheduler');
    // Run in background
    res.json({ success: true, msg: 'HTML source collection started' });
    collectHTMLSources().catch(err => console.error('[Collect-HTML] Background error:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

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

module.exports = router;
