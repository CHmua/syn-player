const express = require('express');
const router = express.Router();
const pool = require('../db');
const { searchAcrossSources, getRecentUpdates, parsePlayUrls, checkUrlValid } = require('../services/collect');
const { dedupVods } = require('../utils/dedup');
const cache = require('../services/cache');
const { authMiddleware } = require('../middleware/auth');

// Wrap external poster URLs through image proxy to bypass hotlink/CORS/SSL issues
function proxyImageUrl(url) {
  if (!url) return '';
  // Don't double-wrap already-proxied URLs or local resources
  if (url.startsWith('/api/') || url.includes('picsum.photos') || url.startsWith('data:')) return url;
  if (!url.startsWith('http')) return url;
  return '/api/vod/image-proxy?url=' + encodeURIComponent(url);
}

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
      enrichVodsWithTMDB(results).catch(() => {});
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
      // Attach proxied poster URL for hotlink/CORS/SSL bypass
      vod.poster_url = proxyImageUrl(vod.vod_pic || '');
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

  const parsed = new URL(imgUrl);
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
    timeout: 12000
  };

  transport.get(imgUrl, opts, (imgRes) => {
    // Follow redirects (up to 3)
    if ([301, 302, 303, 307, 308].includes(imgRes.statusCode)) {
      const redirectUrl = imgRes.headers.location;
      if (redirectUrl) {
        const redirectParsed = new URL(redirectUrl, imgUrl);
        const redirectTransport = redirectParsed.protocol === 'https:' ? require('https') : require('http');
        opts.headers.Referer = parsed.origin + '/';
        redirectTransport.get(redirectParsed.href, opts, (redirectRes) => {
          pipeImageResponse(redirectRes, res);
        }).on('error', () => sendPlaceholder(res));
        return;
      }
    }
    pipeImageResponse(imgRes, res);
  }).on('error', (err) => {
    if (!res.headersSent) sendPlaceholder(res);
  });
});

function pipeImageResponse(source, dest) {
  if (source.statusCode !== 200) {
    return sendPlaceholder(dest);
  }
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

// Async TMDB poster enrichment for VOD records (fire-and-forget)
async function enrichVodsWithTMDB(vods) {
  if (!vods || vods.length === 0) return;
  try {
    const { enrichVods } = require('../services/tmdb');
    const enriched = await enrichVods(vods.slice(0, 10)); // limit to 10 to avoid rate limits
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

module.exports = router;
