const express = require('express');
const router = express.Router();
const { enrichVod, enrichVods, searchMovie, getSubjectDetail } = require('../services/douban');
const cache = require('../services/cache');

// --------------- Search Douban ---------------
router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ success: false, msg: '请输入关键词' });

  try {
    const cacheKey = `douban_search:${query}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, data: cached, source: 'cache' });

    const result = await searchMovie(query);
    if (!result) return res.json({ success: true, data: null, msg: '未找到' });

    await cache.set(cacheKey, result, 86400);
    res.json({ success: true, data: result, source: 'douban' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// --------------- Get subject detail ---------------
router.get('/subject/:doubanId', async (req, res) => {
  try {
    const cacheKey = `douban_subject:${req.params.doubanId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, data: cached, source: 'cache' });

    const detail = await getSubjectDetail(req.params.doubanId);
    if (!detail) return res.status(404).json({ success: false, msg: '未找到' });

    await cache.set(cacheKey, detail, 86400);
    res.json({ success: true, data: detail, source: 'douban' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// --------------- Enrich single VOD ---------------
router.get('/enrich/:vodId', async (req, res) => {
  try {
    const pool = require('../db');
    const [rows] = await pool.query('SELECT * FROM vods WHERE vod_id = ?', [req.params.vodId]);
    if (rows.length === 0) return res.status(404).json({ success: false, msg: '影片不存在' });

    const enriched = await enrichVod(rows[0]);
    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// --------------- Batch enrich (20 at a time) ---------------
router.post('/enrich-batch', async (req, res) => {
  try {
    const pool = require('../db');
    const [rows] = await pool.query(
      `SELECT * FROM vods WHERE (douban_id IS NULL OR poster IS NULL OR poster = '') AND is_active = 1 AND vod_name IS NOT NULL AND vod_name != '' LIMIT 20`
    );
    if (rows.length === 0) return res.json({ success: true, msg: '没有需要刮削的影片', count: 0 });

    const enriched = await enrichVods(rows);
    res.json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// --------------- Batch enrich all (paginated, for initial import) ---------------
router.post('/enrich-all', async (req, res) => {
  try {
    const pool = require('../db');
    let offset = 0;
    const limit = 20;
    let total = 0;

    while (true) {
      const [rows] = await pool.query(
        `SELECT * FROM vods WHERE (douban_id IS NULL OR poster IS NULL OR poster = '') AND is_active = 1 AND vod_name IS NOT NULL AND vod_name != '' LIMIT ${limit} OFFSET ${offset}`
      );
      if (rows.length === 0) break;

      await enrichVods(rows);
      total += rows.length;
      offset += limit;

      // Avoid overwhelming douban
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ success: true, msg: `处理完成`, total });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

module.exports = router;
