const express = require('express');
const https = require('https');
const router = express.Router();

const MAOYAN_HOST = 'm.maoyan.com';
const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ===== In-memory cache =====
var cache = {
  home: null,
  categories: null,
  categoryPages: {}
};

// Category tabs matching Maoyan movie types
const CATEGORIES = [
  { slug: 'all', name: '全部', tag: 'hot' },
  { slug: 'nowplaying', name: '正在热映', tag: 'nowplaying' },
  { slug: 'action', name: '动作', tag: '动作' },
  { slug: 'comedy', name: '喜剧', tag: '喜剧' },
  { slug: 'scifi', name: '科幻', tag: '科幻' },
  { slug: 'drama', name: '剧情', tag: '剧情' },
  { slug: 'horror', name: '恐怖', tag: '恐怖' },
  { slug: 'romance', name: '爱情', tag: '爱情' },
  { slug: 'anime', name: '动画', tag: '动画' },
  { slug: 'documentary', name: '纪录片', tag: '纪录片' },
  { slug: 'war', name: '战争', tag: '战争' }
];

function cacheAge(entry) {
  return entry ? Date.now() - entry.timestamp : Infinity;
}

function isStale(entry) {
  return cacheAge(entry) > REFRESH_INTERVAL;
}

// ===== HTTP fetch =====
function fetchMaoyan(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: MAOYAN_HOST,
      path: path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json',
        'Referer': 'https://m.maoyan.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      rejectUnauthorized: false,
      timeout: 10000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ===== Map movie to article format =====
function movieToArticle(m, category) {
  return {
    url: 'https://m.maoyan.com/movie/' + m.id,
    title: m.nm || m.title || '',
    date: m.rt || m.comingTitle || '',
    category: category || '猫眼电影',
    excerpt: (m.sc ? '评分 ' + m.sc : '') +
      (m.star ? ' | 主演: ' + m.star : '') +
      (m.version ? ' | ' + m.version : '') +
      (m.showInfo ? ' | ' + m.showInfo : ''),
    image: m.img || '',
    rating: m.sc || '',
    wish: m.wish || 0
  };
}

// ===== Fetch movie list =====
async function fetchMovieList(type) {
  // type: 'hot' = now playing, 'coming' = coming soon
  const path = type === 'coming'
    ? '/ajax/comingList?limit=20'
    : '/ajax/movieOnInfoList';

  try {
    const data = await fetchMaoyan(path);
    const movies = data.movieList || data.coming || [];
    return movies;
  } catch (err) {
    console.error('[Maoyan] Fetch ' + type + ' failed:', err.message);
    return [];
  }
}

// ===== Main refresh =====
async function refreshHome() {
  try {
    const [nowPlaying] = await Promise.all([
      fetchMovieList('hot')
    ]);

    const seen = new Set();
    const allArticles = [];

    nowPlaying.forEach(m => {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        allArticles.push(movieToArticle(m, '正在热映'));
      }
    });

    const headlines = allArticles.slice(0, 5);
    const articles = allArticles;

    cache.home = { articles, headlines, timestamp: Date.now() };
    console.log('[MaoyanCache] Home refreshed: ' + headlines.length + ' highlights, ' + articles.length + ' movies');
  } catch (err) {
    console.error('[MaoyanCache] Home refresh failed:', err.message);
  }
}

async function refreshCategories() {
  cache.categories = { categories: CATEGORIES, timestamp: Date.now() };
}

async function refreshAll() {
  console.log('[MaoyanCache] Starting refresh...');
  await Promise.all([refreshHome(), refreshCategories()]);
}

// Initial load
refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);

// ===== API Routes =====

// GET /api/news - main feed
router.get('/', (req, res) => {
  if (!cache.home) {
    refreshHome().catch(() => {});
    return res.json({ success: true, articles: [], headlines: [], source: 'maoyan.com', cached: false });
  }

  if (isStale(cache.home)) {
    refreshHome().catch(() => {});
  }

  res.json({
    success: true,
    articles: (cache.home.articles || []).slice(0, 30),
    headlines: cache.home.headlines || [],
    source: 'maoyan.com',
    cached: true,
    lastUpdate: new Date(cache.home.timestamp).toISOString()
  });
});

// GET /api/news/categories
router.get('/categories', (req, res) => {
  if (!cache.categories) {
    refreshCategories().catch(() => {});
    return res.json({ success: true, categories: CATEGORIES, cached: false });
  }
  res.json({ success: true, categories: cache.categories.categories, cached: true });
});

// GET /api/news/cache-status
router.get('/cache-status', (req, res) => {
  res.json({
    success: true,
    home: cache.home ? { age: Math.round(cacheAge(cache.home) / 1000) + 's', count: (cache.home.articles || []).length } : null,
    refreshInterval: REFRESH_INTERVAL / 1000 + 's',
    source: 'maoyan.com'
  });
});

// GET /api/news/category/:slug
router.get('/category/:slug', async (req, res) => {
  const slug = req.params.slug;

  // For now, return all movies with tag filter (most categories return same data)
  const entry = cache.categoryPages[slug];
  if (entry && !isStale(entry)) {
    return res.json({ success: true, articles: entry.articles.slice(0, 30), source: 'maoyan.com', cached: true });
  }

  try {
    const movies = await fetchMovieList('hot');
    const catInfo = CATEGORIES.find(c => c.slug === slug) || { name: '全部' };
    const articles = movies.map(m => movieToArticle(m, catInfo.name));
    cache.categoryPages[slug] = { articles, timestamp: Date.now() };
    res.json({ success: true, articles: articles.slice(0, 30), source: 'maoyan.com' });
  } catch (err) {
    const stale = cache.categoryPages[slug];
    if (stale && stale.articles.length) {
      return res.json({ success: true, articles: stale.articles, source: 'maoyan.com', cached: true, stale: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/article/:id - movie detail
router.get('/article/:id', async (req, res) => {
  try {
    const movieId = req.params.id.replace(/[^0-9]/g, '');
    if (!movieId) return res.status(400).json({ success: false, error: 'Invalid ID' });

    // Try to fetch movie detail
    const data = await fetchMaoyan('/ajax/detailmovie?movieId=' + movieId);

    const detail = data.detailMovie || data || {};
    const article = {
      title: detail.nm || '',
      date: detail.rt || '',
      source: '猫眼电影',
      category: '正在热映',
      content: (detail.dra || '暂无简介') + '\n\n' +
        (detail.dir ? '导演: ' + detail.dir + '\n' : '') +
        (detail.star ? '主演: ' + detail.star + '\n' : '') +
        (detail.sc ? '评分: ' + detail.sc + '/10' : ''),
      images: detail.img ? [detail.img] : [],
      rating: detail.sc || ''
    };

    res.json({ success: true, article, source: 'maoyan.com' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/image-proxy - proxy Maoyan images
router.get('/image-proxy', (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl || !imgUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const client = imgUrl.startsWith('https') ? https : require('http');
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://m.maoyan.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    rejectUnauthorized: false
  };

  client.get(imgUrl, opts, (imgRes) => {
    if (imgRes.statusCode !== 200) {
      return res.status(imgRes.statusCode).end();
    }
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', () => res.status(500).end());
});

module.exports = router;
