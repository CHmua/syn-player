const express = require('express');
const router = express.Router();
const { enrichVod, enrichVods, searchMovie, posterUrl, isConfigured } = require('../services/tmdb');
const cache = require('../services/cache');

// --------------- Search TMDB directly ---------------
router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ success: false, msg: 'Missing query' });

  if (!isConfigured()) return res.json({ success: false, msg: 'TMDB API key not configured' });

  try {
    const cacheKey = `tmdb_search:${query}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, data: cached, source: 'cache' });

    const result = await searchMovie(query);
    if (!result) return res.json({ success: true, data: null, msg: 'No results' });

    const data = {
      tmdb_id: result.id,
      title: result.title || result.name,
      poster: posterUrl(result.poster_path, 'w500'),
      poster_w300: posterUrl(result.poster_path, 'w300'),
      backdrop: posterUrl(result.backdrop_path, 'w1280'),
      year: (result.release_date || result.first_air_date || '').substring(0, 4),
      rating: result.vote_average,
      overview: result.overview
    };

    await cache.set(cacheKey, data, 86400);
    res.json({ success: true, data, source: 'tmdb' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// --------------- Enrich a VOD record with TMDB ---------------
router.get('/enrich/:vodId', async (req, res) => {
  if (!isConfigured()) return res.json({ success: false, msg: 'TMDB not configured' });

  try {
    const pool = require('../db');
    const [rows] = await pool.query('SELECT * FROM vods WHERE vod_id = ?', [req.params.vodId]);
    if (rows.length === 0) return res.status(404).json({ success: false, msg: 'VOD not found' });

    const enriched = await enrichVod(rows[0]);
    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// --------------- Batch enrich ---------------
router.post('/enrich-batch', async (req, res) => {
  if (!isConfigured()) return res.json({ success: false, msg: 'TMDB not configured' });

  try {
    const pool = require('../db');
    const [rows] = await pool.query('SELECT * FROM vods WHERE tmdb_id IS NULL AND is_active = 1 LIMIT 20');
    const enriched = await enrichVods(rows);
    res.json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

module.exports = router;
