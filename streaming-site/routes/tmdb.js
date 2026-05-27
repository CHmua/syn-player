const express = require('express');
const router = express.Router();
const { enrichVod, enrichVods, searchMovie, posterUrl, isConfigured } = require('../services/tmdb');
const cache = require('../services/cache');

// --------------- Search TMDB directly ---------------
router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ success: false, msg: 'Missing query' });

  if (!isConfigured()) return res.json({ success: false, msg: 'TMDB is not available — check TMDB_ENABLED env var or API key' });

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

// --------------- Image proxy ---------------
// Proxies TMDB images through the server to bypass GFW blocks on image.tmdb.org
router.get('/image-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  // Only proxy TMDB image URLs
  if (!url.includes('image.tmdb.org') && !url.includes('api.themoviedb.org')) {
    return res.status(403).json({ error: 'Only TMDB images allowed' });
  }

  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'SynPlayer/1.0' }
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(response.data));
  } catch (err) {
    // Fallback: redirect to a placeholder
    res.status(404).send('');
  }
});

module.exports = router;
