const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../database');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const { heartbeat, getOnlineCount } = require('../middleware/online');
const { dedupVods, normalizeTitle } = require('../utils/dedup');

const router = express.Router();

// Proxy external images to bypass SSL errors and anti-hotlinking
router.get('/img-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Only allow image URLs from known hosts
  const allowedHosts = ['doubanio.com', 'dbzy5.com', 'picsum.photos', 'upload.vod', 'mtzy1.com', 'bfvvs.com', 'lz-cdn.com'];
  const isAllowed = allowedHosts.some(h => url.includes(h)) || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);
  if (!isAllowed) return res.status(403).json({ error: 'unsupported domain' });

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'Referer': url.includes('douban') ? 'https://movie.douban.com/' : url.includes('mtzy') ? 'https://mtzy1.com/' : new URL(url).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
    });
    const ct = response.headers['content-type'] || 'image/jpeg';
    res.set({
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(502).json({ error: 'proxy fetch failed' });
  }
});

// Rewrite douban poster URLs to go through our proxy (bypass anti-hotlinking)
function proxyPosterUrl(url) {
  if (!url) return url;
  // Already proxied — don't double-wrap
  if (url.startsWith('/api/img-proxy')) return url;
  if (url.includes('doubanio.com')) {
    return '/api/img-proxy?url=' + encodeURIComponent(url);
  }
  return url;
}

// Strip unwanted suffixes from titles (category labels, season info, etc.)
function cleanTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*\(豆瓣\)\s*$/, '')
    .replace(/\s*\[豆瓣\]\s*$/, '')
    .replace(/\s*-\s*豆瓣\s*$/, '')
    .replace(/\s*\([^)]*电视[^)]*\)\s*$/i, '')
    .replace(/\s*-\s*(?:电视剧|电影|综艺|动漫|纪录片|动画|真人秀|剧情|喜剧|动作|科幻|恐怖|悬疑|爱情)\s*$/, '')
    .replace(/\s+第[一二三四五六七八九十\d]+季\s*$/, '')
    .replace(/\s*Season\s+\d+\s*$/i, '')
    .trim();
}

// Get all categories — homepage sections first, then any additional from DB
router.get('/categories', (req, res) => {
  const homepageSections = [
    { value: 'trendingMovies', label: '热门电影' },
    { value: 'trendingTV', label: '热门电视剧' },
    { value: 'trendingAnime', label: '热门动漫' },
    { value: 'liveTV', label: '电视直播' },
    { value: 'moreRecommend', label: '更多推荐' },
  ];

  // Get distinct categories from SQLite videos table
  const videoRows = db.prepare('SELECT DISTINCT category FROM videos WHERE category IS NOT NULL AND category != \'\' ORDER BY category').all();

  // Get distinct type_name from SQLite vods table
  let vodRows = [];
  try {
    vodRows = db.prepare('SELECT DISTINCT type_name as category FROM vods WHERE type_name IS NOT NULL AND type_name != \'\' ORDER BY type_name').all();
  } catch {}

  // Merge: homepage sections first, then any additional unique categories from DB
  const seen = new Set(homepageSections.map(s => s.value));
  const extra = [];
  for (const r of [...videoRows, ...vodRows]) {
    const val = r.category;
    if (val && !seen.has(val)) {
      seen.add(val);
      extra.push(val);
    }
  }

  res.json({
    homepage: homepageSections,
    all: [...homepageSections.map(s => s.value), ...extra]
  });
});

// Get videos (SQLite + MySQL merged)
// Map frontend section IDs to VOD type_name categories (Chinese)
const SECTION_TYPE_MAP = {
  trendingMovies: ['动作片', '喜剧片', '科幻片', '爱情片', '剧情片', '恐怖片', '伦理片', '悬疑片', '犯罪片'],
  trendingTV: ['国产剧', '香港剧', '台湾剧', '欧美剧', '泰国剧', '海外剧', '日本剧', '韩国剧'],
  trendingAnime: ['日韩动漫', '国产动漫'],
  liveTV: ['记录片', '电影解说', '短剧'],
  moreRecommend: ['*']  // '*' = all types, no filter
};

function getCategoryCondition(category) {
  const types = SECTION_TYPE_MAP[category];
  if (!types || types.length === 0) return null;
  if (types.length === 1 && types[0] === '*') return null; // wildcard = all types
  const placeholders = types.map(() => '?').join(', ');
  return { sql: `type_name IN (${placeholders})`, params: types };
}

router.get('/videos', async (req, res) => {
  const { category, search, limit, featured } = req.query;
  const limitNum = parseInt(limit) || (category === 'moreRecommend' ? 400 : 200);
  const featuredOnly = featured === '1';

  // ============================================================
  //  Phase 1: Load admin-managed videos (SQLite videos table)
  //  These are AUTHORITATIVE — they always take priority over VODs
  // ============================================================
  let adminRows;
  if (featuredOnly) {
    adminRows = db.prepare('SELECT * FROM videos WHERE featured = 1 ORDER BY sort_order').all();
  } else if (search) {
    adminRows = db.prepare('SELECT * FROM videos WHERE title LIKE ? ORDER BY sort_order').all(`%${search}%`);
  } else if (category) {
    adminRows = db.prepare('SELECT * FROM videos WHERE category = ? ORDER BY sort_order').all(category);
  } else {
    adminRows = db.prepare('SELECT * FROM videos ORDER BY sort_order').all();
  }

  const adminVideos = adminRows.map(r => ({
    ...r,
    vod_id: r.vod_id || String(r.id),
    poster: r.poster_url || r.poster || '',
    poster_url: proxyPosterUrl(r.poster_url || r.poster || ''),
    rating_source: r.rating && parseFloat(r.rating) > 0 ? 'TMDB' : '',
    featured: r.featured || 0,
    source: 'video'
  }));

  // If only featured videos requested, include VODs as well
  if (featuredOnly) {
    // Load featured VODs from both DBs
    let vodFeatured = [];
    try {
      const db2 = require('../database');
      let vRows = [];
      try {
        const vodDb = require('../db');
        const [rows] = await vodDb.query('SELECT * FROM vods WHERE is_active = 1 AND featured = 1 ORDER BY updated_at DESC');
        vRows = rows;
      } catch {
        vRows = db2.prepare('SELECT * FROM vods WHERE is_active = 1 AND featured = 1 ORDER BY updated_at DESC').all();
      }
      vodFeatured = vRows.map(r => ({
        id: r.vod_id,
        title: r.vod_name,
        category: r.type_name,
        poster_url: proxyPosterUrl(r.poster || r.vod_pic || ''),
        poster: r.poster || r.vod_pic || '',
        year: r.vod_year,
        rating: r.douban_rating || r.vod_score || '',
        rating_source: (r.douban_rating || r.vod_score) ? (r.douban_id ? '豆瓣' : 'TMDB') : '',
        featured: 1,
        description: r.vod_content || '',
        genre: r.vod_type || '',
        vod_id: r.vod_id,
        source: 'vod'
      }));
    } catch (e) {}
    return res.json([...adminVideos, ...vodFeatured]);
  }

  // Build set of normalized admin titles for dedup against VODs
  const adminTitles = new Set(adminVideos.map(v => normalizeTitle(v.title)).filter(Boolean));

  // ============================================================
  //  Phase 2: Load VOD data (MySQL first, then SQLite fallback)
  //  Exclude VODs whose normalized title matches an admin video
  // ============================================================
  let vodRows = [];
  try {
    let mysqlRows = [];
    try {
      const vodDb = require('../db');
      let sql = 'SELECT * FROM vods WHERE is_active = 1';
      const params = [];
      if (search) {
        sql += ' AND vod_name LIKE ?';
        params.push(`%${search}%`);
      } else if (category) {
        const cond = getCategoryCondition(category);
        if (cond) {
          sql += ' AND ' + cond.sql;
          params.push(...cond.params);
        }
      }
      sql += ' ORDER BY updated_at DESC LIMIT ' + limitNum;
      [mysqlRows] = await vodDb.query(sql, params);

      if (mysqlRows.length === 0 && category && !search) {
        const [allRows] = await vodDb.query(
          'SELECT * FROM vods WHERE is_active = 1 ORDER BY updated_at DESC LIMIT ' + limitNum
        );
        mysqlRows = allRows;
      }
    } catch {
      const db2 = require('../database');
      let s = 'SELECT * FROM vods WHERE is_active = 1';
      const sParams = [];
      if (search) {
        s += ' AND vod_name LIKE ?';
        sParams.push(`%${search}%`);
      } else if (category) {
        const cond = getCategoryCondition(category);
        if (cond) {
          s += ' AND ' + cond.sql;
          sParams.push(...cond.params);
        }
      }
      if (category === 'moreRecommend') {
        s += ' ORDER BY vod_hits DESC, updated_at DESC LIMIT ' + limitNum;
      } else {
        s += ' ORDER BY updated_at DESC LIMIT ' + limitNum;
      }
      mysqlRows = sParams.length > 0
        ? db2.prepare(s).all(...sParams)
        : db2.prepare(s).all();

      if (mysqlRows.length === 0 && category && !search) {
        mysqlRows = db2.prepare(
          'SELECT * FROM vods WHERE is_active = 1 ORDER BY updated_at DESC LIMIT ' + limitNum
        ).all();
      }
    }

    vodRows = mysqlRows.map(r => {
      const rating = r.douban_rating || r.vod_score || '';
      // Detect source: douban_id means Douban enriched this record
      let ratingSource = '';
      if (rating && parseFloat(rating) > 0) {
        ratingSource = r.douban_id ? '豆瓣' : 'TMDB';
      }
      return {
        id: r.vod_id,
        title: r.vod_name,
        category: r.type_name,
        poster_url: proxyPosterUrl(r.poster || r.vod_pic || ''),
        poster: r.poster || r.vod_pic || '',
        year: r.vod_year,
        rating: rating,
        rating_source: ratingSource,
        featured: 0,
        description: r.vod_content || '',
        genre: r.vod_type || '',
        vod_id: r.vod_id,
        douban_id: r.douban_id,
        source: 'vod'
      };
    });
  } catch (err) {
    // Both DBs unavailable
  }

  // Dedup VODs internally first (merge year/lang variants of same title)
  const dedupedVods = dedupVods(vodRows);

  // Filter out VODs whose normalized title matches an admin-managed video
  // Admin data is authoritative — VODs must not shadow admin edits
  const filteredVods = dedupedVods.filter(v => {
    const nt = normalizeTitle(v.title || v.vod_name || '');
    return nt && !adminTitles.has(nt);
  });

  // Merge: admin videos first (authoritative), then non-conflicting VODs
  const merged = [...adminVideos, ...filteredVods];

  res.json(merged);
});

// Get single video (checks videos table, then vods in SQLite, then MySQL)
router.get('/videos/:id', async (req, res) => {
  const id = req.params.id;

  // 1. Try admin-managed videos table (SQLite)
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (row) return res.json({ ...row, poster_url: proxyPosterUrl(row.poster_url || ''), source: 'video' });

  // 2. Try SQLite vods table
  const vod = db.prepare('SELECT * FROM vods WHERE vod_id = ?').get(id);
  if (vod) return res.json({
    id: vod.vod_id, title: vod.vod_name, category: vod.type_name,
    description: vod.vod_content || '', poster_url: proxyPosterUrl(vod.poster || vod.vod_pic || ''),
    video_url: vod.vod_play_url || '', year: vod.vod_year || '', duration: '',
    genre: vod.vod_type || '', rating: parseFloat(vod.douban_rating || vod.vod_score) || 0,
    badge: '', is_live: 0, sort_order: 0, source: 'vod',
    vod_id: vod.vod_id
  });

  // 3. Try MySQL vods table
  try {
    const vodDb = require('../db');
    const [rows] = await vodDb.query('SELECT * FROM vods WHERE vod_id = ? AND is_active = 1', [id]);
    if (rows.length > 0) {
      const v = rows[0];
      return res.json({
        id: v.vod_id, title: v.vod_name, category: v.type_name,
        description: v.vod_content || '', poster_url: proxyPosterUrl(v.poster || v.vod_pic || ''),
        video_url: v.vod_play_url || '', year: v.vod_year || '', duration: '',
        genre: v.vod_type || '', rating: parseFloat(v.douban_rating || v.vod_score) || 0,
        badge: '', is_live: 0, sort_order: 0, source: 'vod',
        vod_id: v.vod_id
      });
    }
  } catch {}

  res.status(404).json({ error: '视频不存在' });
});

// Create video (auth required)
router.post('/videos', authMiddleware, (req, res) => {
  const { title, category, description, poster_url, backdrop_url, video_url, year, duration, genre, rating, badge, is_live, featured, sort_order } = req.body;
  const result = db.prepare(`INSERT INTO videos (title, category, description, poster_url, backdrop_url, video_url, year, duration, genre, rating, badge, is_live, featured, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    title || '', category || '', description || '', poster_url || '', backdrop_url || '', video_url || '', year || '', duration || '', genre || '', rating || 0, badge || '', is_live ? 1 : 0, featured ? 1 : 0, sort_order || 0
  );
  res.json({ id: result.lastInsertRowid });
});

// Toggle featured status for hero carousel (auth required, supports videos + vods)
router.put('/videos/:id/featured', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { featured } = req.body;
  const val = featured ? 1 : 0;

  // Try SQLite videos table first
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE videos SET featured = ? WHERE id = ?').run(val, id);
    return res.json({ success: true, featured: val });
  }

  // Try SQLite vods table
  try {
    const vodsRow = db.prepare('SELECT * FROM vods WHERE vod_id = ?').get(id);
    if (vodsRow) {
      db.prepare('UPDATE vods SET featured = ? WHERE vod_id = ?').run(val, id);
      return res.json({ success: true, featured: val });
    }
  } catch (e) {}

  // Try MySQL vods table
  try {
    const vodDb = require('../db');
    const [rows] = await vodDb.query('SELECT vod_id FROM vods WHERE vod_id = ?', [id]);
    if (rows.length > 0) {
      await vodDb.query('UPDATE vods SET featured = ? WHERE vod_id = ?', [val, id]);
      return res.json({ success: true, featured: val });
    }
  } catch (e) {}

  res.status(404).json({ error: '视频不存在' });
});

// Update video (auth required, supports videos, vods SQLite, and MySQL vods)
router.put('/videos/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { title, category, description, poster_url, backdrop_url, video_url, year, duration, genre, rating, badge, is_live, featured, sort_order } = req.body;

  // Helper: perform the update on a SQLite videos row
  function updateVideosRow(existing) {
    db.prepare(`UPDATE videos SET title=?, category=?, description=?, poster_url=?, backdrop_url=?, video_url=?, year=?, duration=?, genre=?, rating=?, badge=?, is_live=?, featured=?, sort_order=? WHERE id=?`).run(
      title !== undefined ? title : existing.title,
      category !== undefined ? category : existing.category,
      description !== undefined ? description : existing.description,
      poster_url !== undefined ? poster_url : existing.poster_url,
      backdrop_url !== undefined ? backdrop_url : existing.backdrop_url,
      video_url !== undefined ? video_url : existing.video_url,
      year !== undefined ? year : existing.year,
      duration !== undefined ? duration : existing.duration,
      genre !== undefined ? genre : existing.genre,
      rating !== undefined ? rating : existing.rating,
      badge !== undefined ? badge : existing.badge,
      is_live !== undefined ? is_live : existing.is_live,
      featured !== undefined ? featured : existing.featured,
      sort_order !== undefined ? sort_order : existing.sort_order,
      id
    );
  }

  // 1. Try SQLite videos table (admin-managed content)
  let existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (existing) {
    updateVideosRow(existing);
    // Also try to push video_url to MySQL if a matching VOD exists
    if (video_url !== undefined) {
      await syncVideoUrlToMySQL(existing.title, video_url);
    }
    return res.json({ success: true });
  }

  // 2. Try SQLite vods table
  existing = db.prepare('SELECT * FROM vods WHERE vod_id = ?').get(id);
  if (existing) {
    const updates = {};
    if (title !== undefined) updates.vod_name = title;
    if (category !== undefined) updates.type_name = category;
    if (description !== undefined) updates.vod_content = description;
    if (poster_url !== undefined) updates.poster = poster_url;
    if (video_url !== undefined) updates.vod_play_url = video_url;
    if (year !== undefined) updates.vod_year = year;
    if (genre !== undefined) updates.vod_type = genre;
    if (rating !== undefined) { updates.douban_rating = String(rating); updates.vod_score = String(rating); }
    if (featured !== undefined) updates.featured = featured ? 1 : 0;
    updates.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
    const values = Object.values(updates);
    values.push(id);
    db.prepare(`UPDATE vods SET ${setClauses} WHERE vod_id=?`).run(...values);

    // Also sync video_url to MySQL
    if (video_url !== undefined) {
      await syncVideoUrlToMySQL(existing.vod_name, video_url);
    }
    return res.json({ success: true });
  }

  // 3. Try MySQL vods table
  try {
    const vodDb = require('../db');
    const [rows] = await vodDb.query('SELECT * FROM vods WHERE vod_id = ?', [id]);
    if (rows.length > 0) {
      const v = rows[0];
      const updates = {};
      if (title !== undefined) updates.vod_name = title;
      if (category !== undefined) updates.type_name = category;
      if (description !== undefined) updates.vod_content = description;
      if (poster_url !== undefined) updates.poster = poster_url;
      if (video_url !== undefined) updates.vod_play_url = video_url;
      if (year !== undefined) updates.vod_year = year;
      if (genre !== undefined) updates.vod_type = genre;
      if (rating !== undefined) { updates.douban_rating = String(rating); updates.vod_score = String(rating); }
      if (featured !== undefined) updates.featured = featured ? 1 : 0;

      const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
      const values = Object.values(updates);
      await vodDb.query(`UPDATE vods SET ${setClauses} WHERE vod_id=?`, [...values, id]);

      // Also save a copy to SQLite videos table so admin data persists independently
      // Use INSERT OR REPLACE to ensure the admin's edited version always exists locally
      const existingLocal = db.prepare('SELECT * FROM videos WHERE title = ?').get(v.vod_name);
      if (existingLocal) {
        updateVideosRow(existingLocal);
      } else {
        db.prepare(`INSERT INTO videos (title, category, description, poster_url, backdrop_url, video_url, year, duration, genre, rating, badge, is_live, featured, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          title !== undefined ? title : v.vod_name,
          category !== undefined ? category : v.type_name,
          description !== undefined ? description : (v.vod_content || ''),
          poster_url !== undefined ? poster_url : (v.poster || v.vod_pic || ''),
          backdrop_url !== undefined ? backdrop_url : '',
          video_url !== undefined ? video_url : (v.vod_play_url || ''),
          year !== undefined ? year : (v.vod_year || ''),
          duration !== undefined ? duration : '',
          genre !== undefined ? genre : (v.vod_type || ''),
          rating !== undefined ? rating : (parseFloat(v.douban_rating || v.vod_score) || 0),
          badge !== undefined ? badge : '',
          is_live !== undefined ? is_live : 0,
          featured !== undefined ? featured : 0,
          sort_order !== undefined ? sort_order : 0
        );
      }
      return res.json({ success: true });
    }
  } catch (err) {
    console.error('[API] MySQL update error:', err.message);
  }

  res.status(404).json({ error: '视频不存在' });
});

// Sync video_url back to MySQL vods table when admin updates a video
async function syncVideoUrlToMySQL(title, videoUrl) {
  if (!title || !videoUrl) return;
  try {
    const vodDb = require('../db');
    await vodDb.query(
      "UPDATE vods SET vod_play_url = ?, updated_at = CURRENT_TIMESTAMP WHERE vod_name LIKE ? AND (vod_play_url IS NULL OR vod_play_url = '')",
      [videoUrl, `%${title}%`]
    );
  } catch {}
}

// Delete video (auth required, handles SQLite videos, SQLite vods, AND MySQL vods)
router.delete('/videos/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;

  // 1. Try SQLite videos table (admin-managed)
  let existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (existing) {
    const title = existing.title;
    db.prepare('DELETE FROM videos WHERE id = ?').run(id);

    // Also soft-delete matching VOD in MySQL by title
    if (title) await softDeleteMySQLVod(title);
    return res.json({ success: true });
  }

  // 2. Try SQLite vods table
  existing = db.prepare('SELECT * FROM vods WHERE vod_id = ?').get(id);
  if (existing) {
    db.prepare('DELETE FROM vods WHERE vod_id = ?').run(id);

    // Also soft-delete from MySQL
    try {
      const vodDb = require('../db');
      await vodDb.query('UPDATE vods SET is_active = 0 WHERE vod_id = ?', [id]);
    } catch {}
    return res.json({ success: true });
  }

  // 3. Try MySQL vods table directly (vod might only exist in MySQL)
  try {
    const vodDb = require('../db');
    const [rows] = await vodDb.query('SELECT * FROM vods WHERE vod_id = ?', [id]);
    if (rows.length > 0) {
      await vodDb.query('UPDATE vods SET is_active = 0 WHERE vod_id = ?', [id]);
      return res.json({ success: true });
    }
  } catch {}

  res.status(404).json({ error: '视频不存在' });
});

// Soft-delete a VOD from MySQL by matching title
async function softDeleteMySQLVod(title) {
  if (!title) return;
  try {
    const vodDb = require('../db');
    await vodDb.query('UPDATE vods SET is_active = 0 WHERE vod_name LIKE ?', [`%${title}%`]);
  } catch {}
}

// Admin login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// Online user count (public)
router.get('/online', (req, res) => {
  res.json({ count: getOnlineCount() });
});

// Heartbeat — registers user presence (requires user token)
router.post('/online/heartbeat', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    const hash = crypto.createHash('sha256').update(String(decoded.id)).digest('hex');
    heartbeat(hash);
    res.json({ count: getOnlineCount() });
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
});

// Search movie poster via Bing image search
router.get('/search-poster', async (req, res) => {
  const title = req.query.title;
  if (!title) return res.status(400).json({ error: 'title required' });

  try {
    // Try Douban first (works best in China)
    try {
      const dbResponse = await axios.get('https://movie.douban.com/j/subject_suggest', {
        params: { q: title },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://movie.douban.com/'
        },
        timeout: 6000
      });

      if (Array.isArray(dbResponse.data) && dbResponse.data.length > 0) {
        const results = dbResponse.data.slice(0, 5).map(item => ({
          title: item.title,
          year: item.year || '',
          poster: proxyPosterUrl(item.img || item.pic || ''),
          id: item.id
        })).filter(r => r.poster);

        if (results.length > 0) {
          return res.json({ success: true, posters: results });
        }
      }
    } catch (e) { /* Douban failed, try Bing */ }

    // Fallback: Bing image search
    const query = encodeURIComponent(title + ' 电影海报');
    const bingUrl = 'https://www.bing.com/images/search?q=' + query + '&first=1&count=5';
    const bingResponse = await axios.get(bingUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: 10000
    });

    // Extract murl (media URL) from Bing's inline data
    const html = bingResponse.data;
    const posters = [];
    const murlRegex = /murl&quot;:&quot;(https?:\/\/[^&]+?\.(?:jpg|jpeg|png|webp))/gi;
    let match;
    while ((match = murlRegex.exec(html)) !== null) {
      let imgUrl = match[1]
        .replace(/\\u002f/g, '/')
        .replace(/\\/g, '');
      if (!posters.includes(imgUrl) && !imgUrl.includes('bing.com/th?')) {
        posters.push(imgUrl);
      }
      if (posters.length >= 5) break;
    }

    if (posters.length > 0) {
      return res.json({ success: true, posters: posters.map(p => ({ title: title, poster: p })) });
    }

    res.json({ success: false, posters: [] });
  } catch (err) {
    res.json({ success: false, posters: [] });
  }
});

// Auto-fill video metadata — TMDB first, Douban fallback (admin auth required)
router.get('/auto-fill', authMiddleware, async (req, res) => {
  const title = (req.query.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });

  // Prefer Chinese title over English
  function preferChineseTitle(candidateTitle, fallbackTitle) {
    if (!candidateTitle) return fallbackTitle || '';
    if (/[一-鿿]/.test(candidateTitle)) return candidateTitle;
    if (fallbackTitle && /[一-鿿]/.test(fallbackTitle)) return fallbackTitle;
    return candidateTitle || fallbackTitle || '';
  }

  try {
    let best = null;

    // Step 1: TMDB (primary — best poster quality + full metadata)
    try {
      const { searchMovieFull: searchTMDB } = require('../services/tmdb');
      const tmdbResult = await searchTMDB(title);
      if (tmdbResult) {
        best = {
          title: cleanTitle(tmdbResult.title || title),
          poster: tmdbResult.poster || '',
          backdrop_url: tmdbResult.backdrop || '',
          year: tmdbResult.year || '',
          rating: tmdbResult.rating || '',
          genre: tmdbResult.genre || '',
          description: tmdbResult.description || '',
          director: tmdbResult.director || '',
          actors: tmdbResult.actors || '',
          douban_id: '',
          tmdb_id: tmdbResult.tmdb_id || ''
        };
        if (tmdbResult.duration) best.duration = tmdbResult.duration;
      }
    } catch { /* TMDB optional */ }

    // Step 2: Douban fallback — when TMDB found nothing or no poster
    if (!best || !best.poster) {
      const { searchMovie, getMobileSubjectDetail } = require('../services/douban');

      // Step 2a: Douban HTML scraper
      try {
        const result = await searchMovie(title);
        if (result && result.douban_id) {
          const dbEntry = {
            title: cleanTitle(preferChineseTitle(result.title, title)),
            poster: proxyPosterUrl(result.poster || ''),
            year: result.year || '',
            rating: result.rating || '',
            genre: '',
            description: result.description || '',
            director: result.director || '',
            actors: result.actors || '',
            douban_id: result.douban_id
          };

          // Mobile detail for Chinese title, synopsis, genre
          try {
            const mobileDetail = await getMobileSubjectDetail(result.douban_id);
            if (mobileDetail) {
              if (mobileDetail.title && /[一-鿿]/.test(mobileDetail.title)) {
                dbEntry.title = cleanTitle(mobileDetail.title);
              }
              if (mobileDetail.summary) dbEntry.description = mobileDetail.summary;
              if (mobileDetail.rating && !dbEntry.rating) dbEntry.rating = mobileDetail.rating;
              if (mobileDetail.genres && mobileDetail.genres.length > 0) {
                dbEntry.genre = mobileDetail.genres.join(' / ');
              }
              if (mobileDetail.duration) dbEntry.duration = mobileDetail.duration;
              if (mobileDetail.director && !dbEntry.director) dbEntry.director = mobileDetail.director;
            }
          } catch {}

          if (!best) {
            best = dbEntry;
          } else if (!best.poster && dbEntry.poster) {
            best.poster = dbEntry.poster;
            if (!best.year && dbEntry.year) best.year = dbEntry.year;
            if (!best.rating && dbEntry.rating) best.rating = dbEntry.rating;
            if (!best.genre && dbEntry.genre) best.genre = dbEntry.genre;
            if (!best.description && dbEntry.description) best.description = dbEntry.description;
            if (!best.director && dbEntry.director) best.director = dbEntry.director;
            if (!best.actors && dbEntry.actors) best.actors = dbEntry.actors;
          }
          if (dbEntry.douban_id) best.douban_id = dbEntry.douban_id;
        }
      } catch {}

      // Step 2b: Douban suggest API (lighter, more reliable)
      if (!best || !best.poster) {
        try {
          const suggestRes = await axios.get('https://movie.douban.com/j/subject_suggest', {
            params: { q: title },
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://movie.douban.com/'
            },
            timeout: 8000
          });

          if (Array.isArray(suggestRes.data) && suggestRes.data.length > 0) {
            const items = suggestRes.data.filter(r => r.id && r.img);
            if (items.length > 0) {
              const chineseItems = items.filter(r => /[一-鿿]/.test(r.title || ''));
              const item = chineseItems.length > 0 ? chineseItems[0] : items[0];
              const suggestEntry = {
                title: cleanTitle(preferChineseTitle(item.title, title)),
                poster: proxyPosterUrl(item.img || ''),
                year: item.year || '',
                rating: '',
                genre: '',
                description: '',
                director: '',
                actors: '',
                douban_id: String(item.id)
              };

              try {
                const mobileDetail = await getMobileSubjectDetail(item.id);
                if (mobileDetail) {
                  if (mobileDetail.title && /[一-鿿]/.test(mobileDetail.title)) {
                    suggestEntry.title = cleanTitle(mobileDetail.title);
                  }
                  if (mobileDetail.summary) suggestEntry.description = mobileDetail.summary;
                  if (mobileDetail.rating) suggestEntry.rating = mobileDetail.rating;
                  if (mobileDetail.genres && mobileDetail.genres.length > 0) {
                    suggestEntry.genre = mobileDetail.genres.join(' / ');
                  }
                  if (mobileDetail.duration) suggestEntry.duration = mobileDetail.duration;
                  if (mobileDetail.director) suggestEntry.director = mobileDetail.director;
                }
              } catch {}

              if (!best) {
                best = suggestEntry;
              } else if (!best.poster && suggestEntry.poster) {
                best.poster = suggestEntry.poster;
              }
            }
          }
        } catch {}
      }
    }

    // Step 3: Search VOD database for matching video source URL (try MySQL first, then SQLite)
    if (best) {
      try {
        const searchTitle = best.title || title;
        let vodRow = null;

        // Try MySQL first (primary VOD storage)
        try {
          const vodDb = require('../db');
          const [rows] = await vodDb.query(
            "SELECT vod_play_url, source_name FROM vods WHERE vod_name LIKE ? AND vod_play_url IS NOT NULL AND vod_play_url != '' LIMIT 1",
            [`%${searchTitle}%`]
          );
          if (rows.length > 0) vodRow = rows[0];
        } catch {
          // MySQL not available, try SQLite
          try {
            vodRow = db.prepare(
              "SELECT vod_play_url, source_name FROM vods WHERE vod_name LIKE ? AND vod_play_url IS NOT NULL AND vod_play_url != '' LIMIT 1"
            ).get(`%${searchTitle}%`);
          } catch { /* both failed */ }
        }

        if (vodRow && vodRow.vod_play_url) {
          // Return full multi-episode URL (format: 第01集$URL#第02集$URL#...)
          best.video_url = vodRow.vod_play_url;
          best.video_source = vodRow.source_name || '';
        }
      } catch { /* VOD search is optional */ }
    }

    if (best && (best.title || best.poster)) {
      return res.json({ success: true, data: best });
    }

    res.json({ success: false, msg: '未找到匹配的影片信息' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Batch auto-fill: enrich all existing videos — TMDB first, Douban fallback
router.post('/batch-auto-fill', authMiddleware, async (req, res) => {
  try {
    const { searchMovie, getMobileSubjectDetail } = require('../services/douban');

    // Get all videos that could benefit from enrichment
    const videos = db.prepare(`
      SELECT * FROM videos WHERE
        (poster_url IS NULL OR poster_url = '' OR poster_url LIKE '%picsum.photos%')
        OR (description IS NULL OR description = '')
        OR (year IS NULL OR year = '')
        OR (genre IS NULL OR genre = '')
        OR (rating IS NULL OR rating = 0)
        OR (video_url IS NULL OR video_url = '' OR video_url LIKE '%BigBuckBunny%' OR video_url LIKE '%ElephantsDream%' OR video_url LIKE '%Sintel%' OR video_url LIKE '%TearsOfSteel%' OR video_url LIKE '%ForBiggerBlazes%')
    `).all();

    let updated = 0;
    let failed = 0;

    for (const v of videos) {
      const title = (v.title || '').trim();
      if (!title || title.length < 2) { failed++; continue; }

      try {
        let best = null;

        // Step 1: TMDB (primary)
        try {
          const { searchMovieFull: searchTMDB } = require('../services/tmdb');
          const tmdbResult = await searchTMDB(title);
          if (tmdbResult) {
            best = {
              title: cleanTitle(tmdbResult.title || title),
              poster: tmdbResult.poster || '',
              backdrop_url: tmdbResult.backdrop || '',
              year: tmdbResult.year || '',
              rating: tmdbResult.rating || '',
              genre: tmdbResult.genre || '',
              description: tmdbResult.description || '',
              director: tmdbResult.director || '',
              actors: tmdbResult.actors || ''
            };
            if (tmdbResult.duration) best.duration = tmdbResult.duration;
          }
        } catch {}

        // Step 2: Douban fallback
        if (!best || !best.poster) {
          try {
            const result = await searchMovie(title);
            if (result && result.douban_id) {
              const dbEntry = {
                title: cleanTitle(result.title || title),
                poster: proxyPosterUrl(result.poster || ''),
                year: result.year || '',
                rating: result.rating || '',
                genre: '',
                description: result.description || '',
                director: result.director || '',
                actors: result.actors || ''
              };

              try {
                const mobileDetail = await getMobileSubjectDetail(result.douban_id);
                if (mobileDetail) {
                  if (mobileDetail.summary) dbEntry.description = mobileDetail.summary;
                  if (mobileDetail.rating && !dbEntry.rating) dbEntry.rating = mobileDetail.rating;
                  if (mobileDetail.genres && mobileDetail.genres.length > 0) {
                    dbEntry.genre = mobileDetail.genres.join(' / ');
                  }
                  if (mobileDetail.duration) dbEntry.duration = mobileDetail.duration;
                  if (mobileDetail.director && !dbEntry.director) dbEntry.director = mobileDetail.director;
                }
              } catch {}

              if (!best) {
                best = dbEntry;
              } else if (!best.poster && dbEntry.poster) {
                best.poster = dbEntry.poster;
                if (!best.year && dbEntry.year) best.year = dbEntry.year;
                if (!best.rating && dbEntry.rating) best.rating = dbEntry.rating;
                if (!best.genre && dbEntry.genre) best.genre = dbEntry.genre;
                if (!best.description && dbEntry.description) best.description = dbEntry.description;
                if (!best.director && dbEntry.director) best.director = dbEntry.director;
                if (!best.actors && dbEntry.actors) best.actors = dbEntry.actors;
              }
            }
          } catch {}
        }

        if (best) {
          // Only update empty/default fields
          try {
            const searchTitle = best.title || title;
            let vodRow = null;
            try {
              const vodDb = require('../db');
              const [rows] = await vodDb.query(
                "SELECT vod_play_url FROM vods WHERE vod_name LIKE ? AND vod_play_url IS NOT NULL AND vod_play_url != '' LIMIT 1",
                [`%${searchTitle}%`]
              );
              if (rows.length > 0) vodRow = rows[0];
            } catch {
              try {
                vodRow = db.prepare(
                  "SELECT vod_play_url FROM vods WHERE vod_name LIKE ? AND vod_play_url IS NOT NULL AND vod_play_url != '' LIMIT 1"
                ).get(`%${searchTitle}%`);
              } catch {}
            }
            if (vodRow && vodRow.vod_play_url) {
              best.video_url = vodRow.vod_play_url;
            }
          } catch {}
        }

        if (best) {
          // Only update empty/default fields
          const fields = [];
          const values = [];

          if ((!v.poster_url || v.poster_url.includes('picsum.photos')) && best.poster) {
            fields.push('poster_url = ?');
            values.push(best.poster);
          }
          if ((!v.description || v.description === '') && best.description) {
            fields.push('description = ?');
            values.push(best.description);
          }
          if ((!v.year || v.year === '') && best.year) {
            fields.push('year = ?');
            values.push(best.year);
          }
          if ((!v.genre || v.genre === '') && best.genre) {
            fields.push('genre = ?');
            values.push(best.genre);
          }
          if ((!v.rating || v.rating === 0) && best.rating) {
            fields.push('rating = ?');
            values.push(parseFloat(best.rating) || 0);
          }
          if ((!v.duration || v.duration === '') && best.duration) {
            fields.push('duration = ?');
            values.push(best.duration);
          }
          if ((!v.video_url || v.video_url.includes('BigBuckBunny') || v.video_url.includes('ElephantsDream') || v.video_url.includes('Sintel') || v.video_url.includes('TearsOfSteel') || v.video_url.includes('ForBiggerBlazes')) && best.video_url) {
            fields.push('video_url = ?');
            values.push(best.video_url);
          }

          if (fields.length > 0) {
            values.push(v.id);
            db.prepare(`UPDATE videos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
            updated++;
          }
        }
      } catch (err) {
        failed++;
        console.error(`[Batch] Failed for "${title}":`, err.message);
      }

      // Rate limiting delay
      await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
    }

    res.json({ success: true, total: videos.length, updated, failed });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Douban poster search — manual lookup from admin UI (auth required)
router.get('/douban-poster', authMiddleware, async (req, res) => {
  const title = (req.query.title || '').trim();
  const year = (req.query.year || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });

  function preferChineseTitle(candidateTitle, fallbackTitle) {
    if (!candidateTitle) return fallbackTitle || '';
    if (/[一-鿿]/.test(candidateTitle)) return candidateTitle;
    if (fallbackTitle && /[一-鿿]/.test(fallbackTitle)) return fallbackTitle;
    return candidateTitle || fallbackTitle || '';
  }

  try {
    const { searchMovie, getMobileSubjectDetail } = require('../services/douban');
    let best = null;

    // Try HTML scraper first
    try {
      const result = await searchMovie(title);
      if (result && result.douban_id) {
        best = {
          title: cleanTitle(preferChineseTitle(result.title, title)),
          poster: proxyPosterUrl(result.poster || ''),
          year: result.year || '',
          rating: result.rating || '',
          genre: '',
          description: result.description || '',
          director: result.director || '',
          actors: result.actors || ''
        };
        try {
          const mobileDetail = await getMobileSubjectDetail(result.douban_id);
          if (mobileDetail) {
            if (mobileDetail.title && /[一-鿿]/.test(mobileDetail.title)) {
              best.title = cleanTitle(mobileDetail.title);
            }
            if (mobileDetail.summary) best.description = mobileDetail.summary;
            if (mobileDetail.rating && !best.rating) best.rating = mobileDetail.rating;
            if (mobileDetail.genres && mobileDetail.genres.length > 0) {
              best.genre = mobileDetail.genres.join(' / ');
            }
            if (mobileDetail.duration) best.duration = mobileDetail.duration;
          }
        } catch {}
      }
    } catch {}

    // Fallback: suggest API
    if (!best || !best.poster) {
      try {
        const suggestRes = await axios.get('https://movie.douban.com/j/subject_suggest', {
          params: { q: title },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://movie.douban.com/'
          },
          timeout: 8000
        });
        if (Array.isArray(suggestRes.data) && suggestRes.data.length > 0) {
          const items = suggestRes.data.filter(r => r.id && r.img);
          if (items.length > 0) {
            const chineseItems = items.filter(r => /[一-鿿]/.test(r.title || ''));
            const item = chineseItems.length > 0 ? chineseItems[0] : items[0];
            best = {
              title: cleanTitle(preferChineseTitle(item.title, title)),
              poster: proxyPosterUrl(item.img || ''),
              year: item.year || '',
              rating: '',
              genre: '',
              description: '',
              director: '',
              actors: ''
            };
          }
        }
      } catch {}
    }

    if (best && best.poster) {
      return res.json({ success: true, data: best });
    }
    res.json({ success: false, msg: '豆瓣未找到匹配的海报' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// TMDB poster search — manual lookup from admin UI (auth required)
router.get('/tmdb-poster', authMiddleware, async (req, res) => {
  const title = (req.query.title || '').trim();
  const year = (req.query.year || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });

  try {
    const { searchMovieFull: searchTMDB } = require('../services/tmdb');
    const result = await searchTMDB(title, year);

    if (result && result.poster) {
      return res.json({
        success: true,
        data: {
          poster: result.poster,
          backdrop: result.backdrop || '',
          title: result.title || '',
          year: result.year || '',
          rating: result.rating || '',
          genre: result.genre || '',
          description: result.description || '',
          director: result.director || '',
          actors: result.actors || '',
          duration: result.duration || '',
          tmdb_id: result.tmdb_id || ''
        }
      });
    }

    res.json({ success: false, msg: 'TMDB 未找到匹配的海报' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

module.exports = router;
