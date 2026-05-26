const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../database');
const { authMiddleware, apiAuthMiddleware, JWT_SECRET } = require('../middleware/auth');
const { heartbeat, getOnlineCount } = require('../middleware/online');
const { dedupVods, normalizeTitle } = require('../utils/dedup');

const router = express.Router();

// Wrap external poster URLs through image proxy to bypass hotlink/CORS/SSL issues
function posterProxyUrl(url) {
  if (!url) return '';
  // Don't double-wrap already-proxied URLs or local resources
  if (url.startsWith('/api/') || url.includes('picsum.photos') || url.startsWith('data:')) return url;
  if (!url.startsWith('http')) return url;
  return '/api/vod/image-proxy?url=' + encodeURIComponent(url);
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
router.get('/categories', apiAuthMiddleware, (req, res) => {
  const homepageSections = [
    { value: 'trendingMovies', label: '热门电影' },
    { value: 'trendingTV', label: '热门电视剧' },
    { value: 'trendingAnime', label: '热门动漫' },
    { value: 'trendingVariety', label: '热门综艺' },
    { value: 'liveTV', label: '纪录解说' },
    { value: 'moreRecommend', label: '更多推荐' },
  ];

  // Get distinct categories from SQLite videos table
  const videoRows = db.prepare('SELECT DISTINCT category FROM videos WHERE category IS NOT NULL AND category != \'\' ORDER BY category').all();

  // Get distinct type_name from SQLite vods table
  let vodRows = [];
  try {
    vodRows = db.prepare('SELECT DISTINCT type_name as category FROM vods WHERE type_name IS NOT NULL AND type_name != \'\' AND is_active = 1 ORDER BY type_name').all();
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
  trendingMovies: ['剧情片', '喜剧片', '动作片', '恐怖片', '爱情片', '战争片', '科幻片', '伦理片', '惊悚片'],
  trendingTV: ['国产剧', '欧美剧', '日本剧', '韩国剧', '泰国剧', '台湾剧', '香港剧', '韩剧', '日剧', '泰剧', '美国剧', '港澳剧', '海外剧', 'Netflix自制剧'],
  trendingAnime: ['国产动漫', '日韩动漫', '中国动漫', '日本动漫', '漫剧', '动漫电影', '欧美动漫', '动画片'],
  trendingVariety: ['大陆综艺', '日韩综艺', '港台综艺', '欧美综艺', '综艺'],
  liveTV: ['纪录片', '记录片', '电影解说', '影视解说'],
  moreRecommend: ['*']  // '*' = all types, no filter
};

function getCategoryCondition(category) {
  const types = SECTION_TYPE_MAP[category];
  if (!types || types.length === 0) return null;
  if (types.length === 1 && types[0] === '*') return null; // wildcard = all types
  const placeholders = types.map(() => '?').join(', ');
  return { sql: `type_name IN (${placeholders})`, params: types };
}

router.get('/videos', apiAuthMiddleware, async (req, res) => {
  const { category, search, limit, featured, page } = req.query;
  const limitNum = parseInt(limit) || (category === 'moreRecommend' ? 400 : 200);
  const featuredOnly = featured === '1';
  const pageNum = Math.max(1, parseInt(page) || 1);
  const offset = (pageNum - 1) * limitNum;

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
    adminRows = db.prepare('SELECT * FROM videos ORDER BY featured DESC, sort_order').all();
  }

  const adminVideos = adminRows.map(r => ({
    ...r,
    vod_id: r.vod_id || String(r.id),
    poster: r.poster_url || r.poster || '',
    poster_url: posterProxyUrl(r.poster_url || r.poster || ''),
    rating_source: r.rating && parseFloat(r.rating) > 0 ? 'TMDB' : '',
    featured: r.featured || 0,
    source: 'video'
  }));
  // Featured videos: only return admin-managed videos — user controls hero carousel manually
  if (featuredOnly) {
    return res.json(adminVideos);
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
      sql += ' ORDER BY featured DESC, updated_at DESC LIMIT ' + limitNum + ' OFFSET ' + offset;
      [mysqlRows] = await vodDb.query(sql, params);

      if (mysqlRows.length === 0 && category && !search) {
        const [allRows] = await vodDb.query(
          'SELECT * FROM vods WHERE is_active = 1 ORDER BY featured DESC, updated_at DESC LIMIT ' + limitNum + ' OFFSET ' + offset
        );
        mysqlRows = allRows;
      }
    } catch (mysqlErr) {
      console.log('[API] MySQL error, falling back to SQLite:', mysqlErr.message);
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
        s += ' ORDER BY featured DESC, vod_hits DESC, updated_at DESC LIMIT ' + limitNum + ' OFFSET ' + offset;
      } else {
        s += ' ORDER BY featured DESC, updated_at DESC LIMIT ' + limitNum + ' OFFSET ' + offset;
      }
      mysqlRows = sParams.length > 0
        ? db2.prepare(s).all(...sParams)
        : db2.prepare(s).all();

      if (mysqlRows.length === 0 && category && !search) {
        mysqlRows = db2.prepare(
          'SELECT * FROM vods WHERE is_active = 1 ORDER BY featured DESC, updated_at DESC LIMIT ' + limitNum + ' OFFSET ' + offset
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
        poster_url: posterProxyUrl(r.poster || r.vod_pic || ''),
        poster: r.poster || r.vod_pic || '',
        backdrop_url: r.backdrop_url || '',
        video_url: r.vod_play_url || '',
        year: r.vod_year,
        release_date: r.release_date || '',
        duration: r.duration || '',
        rating: rating,
        rating_source: ratingSource,
        featured: r.featured || 0,
        description: r.vod_content || '',
        genre: r.genre || r.vod_type || '',
        series_title: r.series_title || '',
        season_label: r.season_label || '',
        vod_id: r.vod_id,
        douban_id: r.douban_id,
        source: 'vod'
      };
    });
  } catch (err) {
    // Both DBs unavailable
  }

  // Enrich VODs with Douban posters first (works in China), TMDB as fallback
  try {
    const { enrichVods: enrichDouban } = require('../services/douban');
    const { isAvailable: tmdbAvailable, enrichVods: enrichTMDB } = require('../services/tmdb');
    // Douban first (works in China without proxy)
    vodRows = await enrichDouban(vodRows);
    // TMDB fallback for any VODs still missing posters
    if (tmdbAvailable()) {
      const needPoster = vodRows.filter(v => !v.poster || v.poster === '');
      if (needPoster.length > 0) {
        const tmdbEnriched = await enrichTMDB(needPoster);
        // Merge back
        for (let i = 0, j = 0; i < vodRows.length && j < needPoster.length; i++) {
          if (!vodRows[i].poster || vodRows[i].poster === '') {
            if (tmdbEnriched[j] && tmdbEnriched[j].poster) {
              vodRows[i] = { ...vodRows[i], ...tmdbEnriched[j] };
            }
            j++;
          }
        }
      }
    }
    // Sync poster_url from enriched poster
    vodRows = vodRows.map(v => ({ ...v, poster_url: posterProxyUrl(v.poster || v.poster_url || '') }));
  } catch (err) {
    console.error('[API] Enrich error:', err.message);
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

  // Paginated response (admin dashboard)
  if (req.query.page) {
    // Get total count for pagination
    let totalAdmin = 0;
    if (search) {
      totalAdmin = db.prepare('SELECT COUNT(*) as c FROM videos WHERE title LIKE ?').get(`%${search}%`).c;
    } else if (category) {
      totalAdmin = db.prepare('SELECT COUNT(*) as c FROM videos WHERE category = ?').get(category).c;
    } else {
      totalAdmin = db.prepare('SELECT COUNT(*) as c FROM videos').get().c;
    }
    // Estimate total VODs (get exact count from the non-deduped rows)
    const paginated = merged.slice(0, limitNum);
    return res.json({
      data: paginated,
      total: paginated.length,  // actual returned count
      page: pageNum,
      per_page: limitNum,
      has_more: paginated.length >= limitNum
    });
  }

  res.json(merged);
});

// Get single video (checks videos table, then vods in SQLite, then MySQL)
router.get('/videos/:id', apiAuthMiddleware, async (req, res) => {
  const id = req.params.id;

  // 1. Try admin-managed videos table (SQLite)
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (row) return res.json({ ...row, poster_url: posterProxyUrl(row.poster_url || ''), source: 'video' });

  // 2. Try SQLite vods table
  const vod = db.prepare('SELECT * FROM vods WHERE vod_id = ?').get(id);
  if (vod) return res.json({
    id: vod.vod_id, title: vod.vod_name, category: vod.type_name,
    description: vod.vod_content || '', poster_url: posterProxyUrl(vod.poster || vod.vod_pic || ''),
    backdrop_url: '', video_url: vod.vod_play_url || '', year: vod.vod_year || '', duration: '',
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
        description: v.vod_content || '', poster_url: posterProxyUrl(v.poster || v.vod_pic || ''),
        backdrop_url: '', video_url: v.vod_play_url || '', year: v.vod_year || '', duration: '',
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
  const { title, category, description, poster_url, backdrop_url, video_url, year, duration, genre, rating, badge, is_live, featured, sort_order, series_title, season_label } = req.body;

  // Helper: perform the update on a SQLite videos row
  function updateVideosRow(existing) {
    db.prepare(`UPDATE videos SET title=?, category=?, description=?, poster_url=?, backdrop_url=?, video_url=?, year=?, duration=?, genre=?, rating=?, badge=?, is_live=?, featured=?, sort_order=?, series_title=?, season_label=? WHERE id=?`).run(
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
      series_title !== undefined ? series_title : (existing.series_title || ''),
      season_label !== undefined ? season_label : (existing.season_label || ''),
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

// Batch delete videos (handles videos table + vods table in both SQLite and MySQL)
router.post('/videos/batch-delete', authMiddleware, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要删除的视频ID列表' });
  }
  const placeholders = ids.map(() => '?').join(',');

  // 1. Delete from SQLite videos table (by integer id)
  const numericIds = ids.map(Number).filter(n => !isNaN(n));
  let vDeleted = 0;
  if (numericIds.length > 0) {
    const np = numericIds.map(() => '?').join(',');
    vDeleted = db.prepare(`DELETE FROM videos WHERE id IN (${np})`).run(...numericIds).changes;
  }

  // 2. Delete from SQLite vods table (by vod_id, both numeric and string)
  const vodResult = db.prepare(`DELETE FROM vods WHERE vod_id IN (${placeholders})`).run(...ids);

  // 3. Also soft-delete from MySQL vods table if available
  let mysqlDeleted = 0;
  try {
    const vodDb = require('../db');
    const [r] = await vodDb.query(`UPDATE vods SET is_active = 0 WHERE vod_id IN (${placeholders})`, ids);
    mysqlDeleted = r.affectedRows || 0;
  } catch {}

  res.json({
    success: true,
    videos_deleted: vDeleted,
    vods_sqlite_deleted: vodResult.changes,
    vods_mysql_soft_deleted: mysqlDeleted
  });
});

// Soft-delete a VOD from MySQL by matching title
async function softDeleteMySQLVod(title) {
  if (!title) return;
  try {
    const vodDb = require('../db');
    await vodDb.query('UPDATE vods SET is_active = 0 WHERE vod_name LIKE ?', [`%${title}%`]);
  } catch {}
}

// ===== Series / Season Grouping =====

// List all series (distinct series_title with video count)
router.get('/series', apiAuthMiddleware, (req, res) => {
  const series = db.prepare(`
    SELECT series_title, COUNT(*) as video_count, MAX(poster_url) as poster_url, MAX(year) as year, MAX(category) as category
    FROM videos WHERE series_title != '' AND series_title IS NOT NULL
    GROUP BY series_title ORDER BY series_title
  `).all();
  res.json(series);
});

// Get series detail — all seasons with episodes
router.get('/series/:encodedTitle', apiAuthMiddleware, (req, res) => {
  const title = decodeURIComponent(req.params.encodedTitle);
  const videos = db.prepare(`
    SELECT * FROM videos WHERE series_title = ? ORDER BY season_label, sort_order, id
  `).all(title);

  if (videos.length === 0) {
    return res.status(404).json({ error: 'Series not found' });
  }

  // Build seasons array, each with episodes from video_url
  const seasons = [];
  const seenLabels = new Map();

  for (const v of videos) {
    const label = v.season_label || '默认';
    let season = seenLabels.get(label);
    if (!season) {
      season = { label, videos: [] };
      seenLabels.set(label, season);
    }
    season.videos.push(v);
  }

  res.json({
    series_title: title,
    video_count: videos.length,
    poster_url: videos[0].poster_url || videos[0].backdrop_url || '',
    backdrop_url: videos[0].backdrop_url || '',
    category: videos[0].category || '',
    year: videos[0].year || '',
    description: videos[0].description || '',
    seasons: [...seenLabels.values()],
  });
});

// Auto-detect series groups across all videos
router.post('/videos/auto-detect-series', authMiddleware, (req, res) => {
  const allVideos = db.prepare('SELECT id, title FROM videos ORDER BY id').all();
  const { analyzeSeries } = require('../utils/series-detect');
  const result = analyzeSeries(allVideos);
  res.json(result);
});

// Apply series grouping to multiple videos
router.put('/videos/apply-series', authMiddleware, (req, res) => {
  const { items } = req.body; // [{ id, series_title, season_label }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }
  const stmt = db.prepare('UPDATE videos SET series_title = ?, season_label = ? WHERE id = ?');
  const updateMany = db.transaction((rows) => {
    let changes = 0;
    for (const r of rows) {
      const result = stmt.run(r.series_title, r.season_label, r.id);
      changes += result.changes;
    }
    return changes;
  });
  const changes = updateMany(items);
  res.json({ success: true, changes });
});

// Remove a video from its series (clear series_title and season_label)
router.put('/videos/:id/remove-from-series', authMiddleware, (req, res) => {
  const result = db.prepare('UPDATE videos SET series_title = \'\', season_label = \'\' WHERE id = ?').run(req.params.id);
  res.json({ success: true, changes: result.changes });
});

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

// Admin change password
router.put('/admin/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '请填写当前密码和新密码' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少需要6个字符' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!admin || !bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(400).json({ error: '当前密码错误' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, req.admin.id);
  res.json({ success: true, message: '密码修改成功' });
});

// Cleanup: remove auto-copied VOD records, keep only seed videos + manually added
router.post('/admin/cleanup', authMiddleware, (req, res) => {
  const seedTitles = [
    '速度与激情 9', '复仇者联盟：终局之战', '巴霍巴利王 2', '蜘蛛侠：英雄无归',
    '怦然心动', '建国大业', '战狼2', '权力的游戏', '狂飙', '三体',
    '父母爱情', '人世间', '脱口秀大会', '密室大逃脱', '欢乐喜剧人', '奔跑吧',
    'CCTV 新闻', 'CGTN 英语新闻'
  ];
  const placeholders = seedTitles.map(() => '?').join(',');
  const vDel = db.prepare(`DELETE FROM videos WHERE title NOT IN (${placeholders})`).run(...seedTitles);
  const vodCount = db.prepare('SELECT COUNT(*) as c FROM vods').get();
  db.prepare('DELETE FROM vods').run();
  db.prepare('DELETE FROM collect_logs').run();
  res.json({ success: true, videos_deleted: vDel.changes, vods_deleted: vodCount.c });
});

// ===== Sync Status & Manual Trigger =====

// Get collection sync status
router.get('/admin/sync-status', authMiddleware, async (req, res) => {
  try {
    // Counts
    const vodCount = db.prepare('SELECT COUNT(*) as c FROM vods WHERE is_active = 1').get().c;
    const vodWithUrl = db.prepare("SELECT COUNT(*) as c FROM vods WHERE is_active = 1 AND vod_play_url IS NOT NULL AND vod_play_url != ''").get().c;
    const videoCount = db.prepare('SELECT COUNT(*) as c FROM videos').get().c;

    // Last sync log
    const lastLog = db.prepare(
      "SELECT * FROM collect_logs WHERE status = 'success' ORDER BY created_at DESC LIMIT 1"
    ).get();

    // VOD count by type
    const typeStats = db.prepare(
      "SELECT type_name, COUNT(*) as c FROM vods WHERE is_active = 1 AND type_name != '' GROUP BY type_name ORDER BY c DESC LIMIT 20"
    ).all();

    res.json({
      vod_count: vodCount,
      vod_with_url: vodWithUrl,
      video_count: videoCount,
      last_sync: lastLog ? {
        type: lastLog.collect_type,
        fetched: lastLog.total_fetched,
        added: lastLog.new_added,
        updated: lastLog.updated_existing,
        duration_ms: lastLog.duration_ms,
        time: lastLog.created_at
      } : null,
      type_stats: typeStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual sync trigger
router.post('/admin/sync-now', authMiddleware, async (req, res) => {
  try {
    const scheduler = require('../services/collect-scheduler');
    const result = await scheduler.runNow();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Reset & re-collect: deletes all VODs and triggers full deep sync + series grouping
let resetInProgress = false;
router.post('/admin/reset-collection', authMiddleware, async (req, res) => {
  if (resetInProgress) {
    return res.json({ success: false, error: '重置采集中，请稍后再试' });
  }
  resetInProgress = true;
  res.json({ success: true, message: '重置采集已开始，请稍后查看同步状态' });

  // Run in background
  (async () => {
    try {
      const scheduler = require('../services/collect-scheduler');

      // Delete all VODs
      const db = require('../database');
      const vodCount = db.prepare('SELECT COUNT(*) as c FROM vods').get().c;
      db.prepare('DELETE FROM vods').run();
      db.prepare('DELETE FROM collect_logs').run();
      console.log(`[Reset] Deleted ${vodCount} VODs, starting fresh collection...`);

      // Full deep sync (pages 1-20)
      await scheduler.fullDeepSync();

      // Series grouping
      await scheduler.groupAllSeries();

      console.log('[Reset] Re-collection complete');
    } catch (err) {
      console.error('[Reset] Error:', err.message);
    } finally {
      resetInProgress = false;
    }
  })();
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
router.get('/search-poster', apiAuthMiddleware, async (req, res) => {
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
          poster: (item.img || item.pic || ''),
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
  const year = (req.query.year || '').trim();
  const category = (req.query.category || '').trim();
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

    // ====================================================================
    //  NEW FLOW: AppleCMS first → TMDB/Douban for metadata
    //  User copies title from dbzy.tv, so we trust AppleCMS for title+URL,
    //  then enrich with TMDB/Douban poster, backdrop, and metadata.
    // ====================================================================

    // Step 1: Search local VOD DB for exact title match (fast path)
    let vodMatch = null;
    try {
      try {
        const vodDb = require('../db');
        const [rows] = await vodDb.query(
          "SELECT * FROM vods WHERE vod_name = ? AND is_active = 1 LIMIT 1", [title]
        );
        if (rows.length > 0) vodMatch = rows[0];
      } catch {
        vodMatch = db.prepare(
          "SELECT * FROM vods WHERE vod_name = ? AND is_active = 1 LIMIT 1"
        ).get(title);
      }
    } catch {}

    // Step 2: Search AppleCMS (dbzy.tv) for the title — get exact match title + play URL
    if (!vodMatch) {
      try {
        const { searchAcrossSources, enrichWithPlayUrls } = require('../services/collect');
        const { results } = await searchAcrossSources(title);
        if (results && results.length > 0) {
          // Find best match: prefer exact title match, then category match
          let scored = results.map(r => {
            let score = 0;
            const rTitle = (r.vod_name || '').trim();
            if (rTitle === title) score += 500;       // exact title match
            else if (rTitle.includes(title) || title.includes(rTitle)) score += 200; // partial match
            if (r.vod_year === year) score += 100;
            if (r.vod_play_url) score += 50;
            return { ...r, _score: score };
          }).sort((a, b) => b._score - a._score);

          // Fetch play URLs for top candidates
          const enriched = await enrichWithPlayUrls(scored.slice(0, 5));
          const withUrl = enriched.filter(r => r.vod_play_url);
          if (withUrl.length > 0) {
            vodMatch = withUrl[0];
          } else if (enriched.length > 0) {
            vodMatch = enriched[0]; // no play URL but keep the title match
          }
        }
      } catch (e) { console.error('[auto-fill] AppleCMS search error:', e.message); }
    }

    // Step 3: Use the matching title for metadata search
    const searchTitle = vodMatch ? (vodMatch.vod_name || title) : title;

    // Step 4: Douban metadata (works in China, no proxy needed)
    try {
      const { searchMovie, getMobileSubjectDetail } = require('../services/douban');
      const result = await searchMovie(searchTitle, year);
      if (result && result.douban_id) {
        const dbEntry = {
          title: cleanTitle(preferChineseTitle(result.title, searchTitle)),
          poster: result.poster || '',
          year: result.year || '',
          rating: result.rating || '',
          genre: '',
          description: result.description || '',
          director: result.director || '',
          actors: result.actors || '',
          douban_id: result.douban_id,
          tmdb_id: ''
          };
          try {
            const mobileDetail = await getMobileSubjectDetail(result.douban_id);
            if (mobileDetail) {
              if (mobileDetail.title && /[一-鿿]/.test(mobileDetail.title)) dbEntry.title = cleanTitle(mobileDetail.title);
              if (mobileDetail.summary) dbEntry.description = mobileDetail.summary;
              if (mobileDetail.rating && !dbEntry.rating) dbEntry.rating = mobileDetail.rating;
              if (mobileDetail.genres && mobileDetail.genres.length > 0) dbEntry.genre = mobileDetail.genres.join(' / ');
              if (mobileDetail.duration) dbEntry.duration = mobileDetail.duration;
              if (mobileDetail.director && !dbEntry.director) dbEntry.director = mobileDetail.director;
            }
          } catch {}
          if (!best) { best = dbEntry; }
          else if (!best.poster && dbEntry.poster) {
            best.poster = dbEntry.poster;
            if (!best.year) best.year = dbEntry.year;
            if (!best.rating) best.rating = dbEntry.rating;
            if (!best.genre) best.genre = dbEntry.genre;
            if (!best.description) best.description = dbEntry.description;
          }
        }
      } catch {}

    // Step 5: TMDB fallback if Douban found nothing or no poster
    if (!best || !best.poster) {
      try {
        const { searchMovieFull: searchTMDB } = require('../services/tmdb');
        const tmdbResult = await searchTMDB(searchTitle, year);
        if (tmdbResult) {
          const tmdbEntry = {
            title: cleanTitle(tmdbResult.title || searchTitle),
            poster: tmdbResult.poster || '',
            backdrop_url: tmdbResult.backdrop_w1280 || tmdbResult.backdrop || '',
            year: tmdbResult.year || '',
            rating: tmdbResult.rating || '',
            genre: tmdbResult.genre || '',
            description: tmdbResult.description || '',
            director: tmdbResult.director || '',
            actors: tmdbResult.actors || '',
            douban_id: '',
            tmdb_id: tmdbResult.tmdb_id || ''
          };
          if (tmdbResult.duration) tmdbEntry.duration = tmdbResult.duration;
          if (!best) { best = tmdbEntry; }
          else {
            if (!best.poster && tmdbEntry.poster) best.poster = tmdbEntry.poster;
            if (!best.year && tmdbEntry.year) best.year = tmdbEntry.year;
            if (!best.rating && tmdbEntry.rating) best.rating = tmdbEntry.rating;
            if (!best.genre && tmdbEntry.genre) best.genre = tmdbEntry.genre;
            if (!best.description && tmdbEntry.description) best.description = tmdbEntry.description;
          }
        }
      } catch { /* TMDB optional */ }
    }

    // Step 6: Attach video source URL from AppleCMS/local match
    if (best && vodMatch && vodMatch.vod_play_url) {
      best.video_url = vodMatch.vod_play_url;
      best.video_source = vodMatch.source_name || '';
    }

    // Don't fall back to poster for backdrop — backdrop should be horizontal (16:9)
    // Poster is vertical and already used as the cover image

    if (best && (best.title || best.poster)) {
      return res.json({ success: true, data: best });
    }

    res.json({ success: false, msg: '未找到匹配的影片信息' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Background enrichment state
let enrichRunning = false;
let enrichProgress = { total: 0, done: 0, updated: 0, failed: 0, current: '' };

// Batch auto-fill: enrich videos + VODs — Douban first (works in China), TMDB fallback
// Runs in background; check GET /api/batch-auto-fill/status for progress
router.post('/batch-auto-fill', authMiddleware, async (req, res) => {
  if (enrichRunning) {
    return res.json({ success: true, running: true, progress: enrichProgress });
  }

  enrichRunning = true;
  enrichProgress = { total: 0, done: 0, updated: 0, failed: 0, current: '准备中...' };

  // Start background work (don't await — return immediately)
  (async () => {
    try {
      const { searchMovie: doubanSearch } = require('../services/douban');
      const { searchMovie: tmdbSearch, isAvailable: tmdbAvailable } = require('../services/tmdb');

      // Get admin videos needing enrichment
      const videos = db.prepare(`
        SELECT * FROM videos WHERE
          (poster_url IS NULL OR poster_url = '' OR poster_url LIKE '%picsum.photos%')
          OR (description IS NULL OR description = '')
          OR (year IS NULL OR year = '')
          OR (genre IS NULL OR genre = '')
          OR (rating IS NULL OR rating = 0)
          OR (video_url IS NULL OR video_url = '' OR video_url LIKE '%BigBuckBunny%' OR video_url LIKE '%ElephantsDream%' OR video_url LIKE '%Sintel%' OR video_url LIKE '%TearsOfSteel%' OR video_url LIKE '%ForBiggerBlazes%')
      `).all();

      // Get VODs needing enrichment
      const vods = db.prepare(`
        SELECT vod_id, vod_name as title, type_name as category, poster, vod_content as description,
               vod_year as year, vod_type as genre, douban_rating, vod_score, vod_play_url as video_url,
               douban_id
        FROM vods WHERE is_active = 1 AND (
          (poster IS NULL OR poster = '')
          OR (douban_rating IS NULL OR douban_rating = '' OR douban_rating = '0.0')
          OR (vod_content IS NULL OR vod_content = '')
        )
        ORDER BY vod_hits DESC, updated_at DESC
        LIMIT 300
      `).all();

      const allItems = [...videos, ...vods];
      enrichProgress.total = allItems.length;
      console.log('[Batch] Starting Douban enrichment of', allItems.length, 'items (', videos.length, 'videos +', vods.length, 'VODs)');

      for (const v of allItems) {
        if (!enrichRunning) break; // Allow cancellation

        const rawTitle = (v.title || '').trim();
        const vodId = v.vod_id || null;
        const isVod = !!vodId;
        enrichProgress.current = rawTitle;
        enrichProgress.done++;

        if (!rawTitle || rawTitle.length < 2) { enrichProgress.failed++; continue; }

        // Pre-clean title for better search match (remove years, season/episode info, language tags)
        const title = rawTitle
          .replace(/第[一二三四五六七八九十\d]+[部季集卷]/g, '')
          .replace(/Season\s*\d+/gi, '')
          .replace(/Part\s*\d+/gi, '')
          .replace(/\(\d{4}\)$/g, '')
          .replace(/\d{4}$/g, '')
          .replace(/\s*\[.*?\]\s*/g, '')
          .replace(/\s*-\s*(粤语|国语|英语|日语|韩语|中字|双语|英文|中文|普通话|四川话|配音|原版|修复版|先行版|预告片).*$/g, '')
          .trim();

        const searchTitle = title.length >= 2 ? title : rawTitle;

        let best = null;

        try {
          // Douban search first (works in China, no proxy needed)
          try {
            const doubanResult = await Promise.race([
              doubanSearch(searchTitle),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);
            if (doubanResult && doubanResult.poster) {
              best = {
                poster: doubanResult.poster,
                year: doubanResult.year || '',
                rating: doubanResult.rating || '',
                description: doubanResult.description || '',
              };
            }
          } catch {}

          // TMDB fallback if Douban found nothing and TMDB is available
          if (!best && tmdbAvailable()) {
            try {
              const tmdbResult = await Promise.race([
                tmdbSearch(searchTitle),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
              ]);
              if (tmdbResult && tmdbResult.poster_path) {
                best = {
                  poster: 'https://image.tmdb.org/t/p/w500' + tmdbResult.poster_path,
                  year: (tmdbResult.release_date || '').substring(0, 4),
                  rating: tmdbResult.vote_average ? String(Math.round(tmdbResult.vote_average * 10) / 10) : '',
                  description: tmdbResult.overview || '',
                };
              }
            } catch {}
          }

          if (best) {
            const fields = [];
            const values = [];

            if (!isVod) {
              const needPoster = !v.poster_url || v.poster_url === '' || v.poster_url.includes('picsum.photos');
              if (needPoster && best.poster) { fields.push('poster_url = ?'); values.push(best.poster); }
              if ((!v.description || v.description === '') && best.description) { fields.push('description = ?'); values.push(best.description); }
              if ((!v.year || v.year === '') && best.year) { fields.push('year = ?'); values.push(best.year); }
              if ((!v.rating || v.rating === 0) && best.rating) { fields.push('rating = ?'); values.push(parseFloat(best.rating) || 0); }
              if (fields.length > 0) {
                values.push(v.id);
                db.prepare(`UPDATE videos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
                enrichProgress.updated++;
              }
            } else {
              const needPoster = !v.poster || v.poster === '';
              if (needPoster && best.poster) { fields.push('poster = ?'); values.push(best.poster); }
              if ((!v.year || v.year === '') && best.year) { fields.push('vod_year = ?'); values.push(String(best.year)); }
              if (best.description && (!v.description || v.description === '')) { fields.push('vod_content = ?'); values.push(best.description); }
              if (best.rating) {
                const needScore = !v.douban_rating || v.douban_rating === '' || v.douban_rating === '0.0';
                if (needScore) { fields.push('douban_rating = ?'); values.push(String(best.rating)); }
              }
              if (fields.length > 0) {
                values.push(vodId);
                db.prepare(`UPDATE vods SET ${fields.join(', ')} WHERE vod_id = ?`).run(...values);
                enrichProgress.updated++;
              }
            }
          } else {
            enrichProgress.failed++;
          }
        } catch (err) {
          enrichProgress.failed++;
        }

        // 500ms between Douban calls (scraper-friendly, avoids rate limiting)
        await new Promise(r => setTimeout(r, 500));

        if (enrichProgress.done % 20 === 0) {
          console.log('[Batch] Progress:', enrichProgress.done, '/', enrichProgress.total, 'updated:', enrichProgress.updated);
        }
      }
      console.log('[Batch] Done:', enrichProgress.updated, 'updated,', enrichProgress.failed, 'failed');
    } catch (err) {
      console.error('[Batch] Fatal error:', err.message);
    } finally {
      enrichRunning = false;
    }
  })();

  res.json({ success: true, running: true, msg: '后台任务已启动', total: enrichProgress.total });
});

// Check batch auto-fill progress
router.get('/batch-auto-fill/status', authMiddleware, (req, res) => {
  res.json({ running: enrichRunning, progress: enrichProgress });
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
          poster: (result.poster || ''),
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
        const doubanCookie = process.env.DOUBAN_COOKIE || '';
        const suggestHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://movie.douban.com/'
        };
        if (doubanCookie) suggestHeaders['Cookie'] = doubanCookie;
        const suggestRes = await axios.get('https://movie.douban.com/j/subject_suggest', {
          params: { q: title },
          headers: suggestHeaders,
          timeout: 8000,
          maxRedirects: 5
        });
        // Douban may return HTML login page instead of JSON when IP is blocked
        if (typeof suggestRes.data === 'string') {
          if (suggestRes.data.includes('登录跳转') || suggestRes.data.includes('异常请求')) {
            console.error('[Douban] Suggest API blocked — IP flagged. Set DOUBAN_COOKIE in .env.');
          }
          suggestRes.data = [];
        }
        if (Array.isArray(suggestRes.data) && suggestRes.data.length > 0) {
          const items = suggestRes.data.filter(r => r.id && r.img);
          if (items.length > 0) {
            const chineseItems = items.filter(r => /[一-鿿]/.test(r.title || ''));
            const item = chineseItems.length > 0 ? chineseItems[0] : items[0];
            best = {
              title: cleanTitle(preferChineseTitle(item.title, title)),
              poster: (item.img || ''),
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

// Backward-compatible image proxy for poster URLs already stored in DB as /api/img-proxy
router.get('/img-proxy', (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl || (!imgUrl.startsWith('http://') && !imgUrl.startsWith('https://'))) {
    return sendPlaceholder(res);
  }

  const parsed = new URL(imgUrl);
  const transport = parsed.protocol === 'https:' ? require('https') : require('http');

  transport.get(imgUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': parsed.origin + '/',
      'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    rejectUnauthorized: false,
    timeout: 12000
  }, (imgRes) => {
    if (imgRes.statusCode !== 200) {
      if ([301, 302, 303, 307, 308].includes(imgRes.statusCode) && imgRes.headers.location) {
        const redirectUrl = new URL(imgRes.headers.location, imgUrl);
        const rt = redirectUrl.protocol === 'https:' ? require('https') : require('http');
        rt.get(redirectUrl.href, { rejectUnauthorized: false, timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': parsed.origin + '/' } }, (r2) => {
          if (r2.statusCode !== 200) return sendPlaceholder(res);
          res.set({ 'Content-Type': r2.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
          r2.pipe(res);
        }).on('error', () => sendPlaceholder(res));
        return;
      }
      return sendPlaceholder(res);
    }
    res.set({ 'Content-Type': imgRes.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    imgRes.pipe(res);
  }).on('error', () => { if (!res.headersSent) sendPlaceholder(res); });
});

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

module.exports = router;
