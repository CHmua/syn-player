const express = require('express');
const https = require('https');
const router = express.Router();

const DOUBAN_API = 'https://movie.douban.com/j';
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

// ===== In-memory cache =====
var cache = {
  home: null,        // { articles, headlines, timestamp }
  categories: null,  // { categories, timestamp }
  categoryPages: {}  // { [tag]: { articles, timestamp } }
};

// Douban movie tags mapped to categories
const DOUBAN_TAGS = [
  { slug: 'hot', name: '热门推荐', tag: '热门' },
  { slug: 'highscore', name: '豆瓣高分', tag: '豆瓣高分' },
  { slug: 'latest', name: '最新上线', tag: '最新' },
  { slug: 'huayu', name: '华语电影', tag: '华语' },
  { slug: 'oumei', name: '欧美电影', tag: '欧美' },
  { slug: 'riben', name: '日本电影', tag: '日本' },
  { slug: 'hanguo', name: '韩国电影', tag: '韩国' },
  { slug: 'dongzuo', name: '动作片', tag: '动作' },
  { slug: 'xiju', name: '喜剧片', tag: '喜剧' },
  { slug: 'kehuan', name: '科幻片', tag: '科幻' },
  { slug: 'aiqing', name: '爱情片', tag: '爱情' },
  { slug: 'kongbu', name: '恐怖片', tag: '恐怖' },
  { slug: 'donghua', name: '动画电影', tag: '动画' },
  { slug: 'jilupian', name: '纪录片', tag: '纪录片' }
];

function cacheAge(entry) {
  return entry ? Date.now() - entry.timestamp : Infinity;
}

function isStale(entry) {
  return cacheAge(entry) > REFRESH_INTERVAL;
}

// ===== HTTP fetch =====
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://movie.douban.com/'
      },
      rejectUnauthorized: false
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ===== Map Douban subject to article format =====
function subjectToArticle(s, categoryName) {
  return {
    url: s.url || ('https://movie.douban.com/subject/' + s.id + '/'),
    title: s.title || '',
    date: '',
    category: categoryName || '豆瓣电影',
    excerpt: (s.rate ? '评分 ' + s.rate + ' / ' + (s.star || '') : '') + (s.directors ? ' | 导演: ' + s.directors.join(', ') : ''),
    image: s.cover || s.pic || '',
    rating: s.rate || '',
    doubanId: s.id || ''
  };
}

// ===== Fetch movies by tag =====
async function fetchDoubanMovies(tag, limit) {
  limit = limit || 20;
  const url = DOUBAN_API + '/search_subjects?type=movie&tag=' + encodeURIComponent(tag) + '&page_limit=' + limit + '&page_start=0';
  try {
    const data = await fetchJson(url);
    return (data.subjects || []).map(s => ({
      id: s.id,
      title: s.title,
      url: s.url,
      cover: s.cover,
      rate: s.rate,
      star: s.star || ''
    }));
  } catch (err) {
    console.error('[Douban] Fetch tag "' + tag + '" failed:', err.message);
    return [];
  }
}

// ===== Fetch subject detail =====
async function fetchSubjectDetail(subjectId) {
  const url = 'https://movie.douban.com/subject/' + subjectId + '/';
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      rejectUnauthorized: false
    }, (res) => {
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => {
        try {
          // Parse director
          const dirM = html.match(/<a[^>]*href="\/celebrity\/\d+\/"[^>]*rel="v:directedBy"[^>]*>([^<]*)<\/a>/);
          const directors = dirM ? [dirM[1].trim()] : [];

          // Parse actors
          const actorRegex = /<a[^>]*href="\/celebrity\/\d+\/"[^>]*rel="v:starring"[^>]*>([^<]*)<\/a>/g;
          const actors = [];
          let am;
          while ((am = actorRegex.exec(html)) !== null && actors.length < 4) {
            actors.push(am[1].trim());
          }

          // Parse summary
          const summaryM = html.match(/<span[^>]*property="v:summary"[^>]*>([\s\S]*?)<\/span>/);
          let summary = '';
          if (summaryM) {
            summary = summaryM[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);
          }

          resolve({ directors, actors, summary });
        } catch (e) {
          resolve({ directors: [], actors: [], summary: '' });
        }
      });
    }).on('error', () => resolve({ directors: [], actors: [], summary: '' }));
  });
}

// ===== Main refresh =====
async function refreshHome() {
  try {
    // Fetch multiple tag categories in parallel
    const [hotMovies, highScore, latest] = await Promise.all([
      fetchDoubanMovies('热门', 20),
      fetchDoubanMovies('豆瓣高分', 10),
      fetchDoubanMovies('最新', 10)
    ]);

    // Deduplicate
    const seen = new Set();
    const allMovies = [];
    const addMovies = (list, cat) => {
      list.forEach(m => {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          allMovies.push(subjectToArticle(m, cat));
        }
      });
    };

    addMovies(hotMovies, '热门推荐');
    addMovies(highScore, '豆瓣高分');
    addMovies(latest, '最新上线');

    // Headlines: first 5 hot movies
    // If we have at least 5, enrich the first few with detail
    const headlines = allMovies.slice(0, 5);
    const articles = allMovies; // All as articles too

    // Enrich top headlines with director/actor info (limit concurrency)
    for (let i = 0; i < Math.min(3, headlines.length); i++) {
      if (headlines[i].doubanId) {
        const detail = await fetchSubjectDetail(headlines[i].doubanId);
        if (detail.directors.length) {
          headlines[i].excerpt = '导演: ' + detail.directors.join(', ') +
            (detail.actors.length ? ' | 主演: ' + detail.actors.join(', ') : '') +
            (detail.summary ? ' | ' + detail.summary.substring(0, 100) : '');
        }
        // Pause briefly between detail requests
        await new Promise(r => setTimeout(r, 300));
      }
    }

    cache.home = { articles, headlines, timestamp: Date.now() };
    console.log('[DoubanCache] Home refreshed: ' + headlines.length + ' headlines, ' + articles.length + ' articles');
  } catch (err) {
    console.error('[DoubanCache] Home refresh failed:', err.message);
  }
}

async function refreshCategories() {
  cache.categories = { categories: DOUBAN_TAGS, timestamp: Date.now() };
}

async function refreshAll() {
  console.log('[DoubanCache] Starting refresh...');
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
    // Return empty while waiting
    return res.json({ success: true, articles: [], headlines: [], source: 'douban.com', cached: false, message: 'Loading data, please refresh' });
  }

  const articles = cache.home.articles || [];
  const headlines = cache.home.headlines || [];

  if (isStale(cache.home)) {
    refreshHome().catch(() => {});
  }

  res.json({
    success: true,
    articles: articles.slice(0, 30),
    headlines,
    source: 'douban.com',
    cached: true,
    lastUpdate: new Date(cache.home.timestamp).toISOString()
  });
});

// GET /api/news/categories
router.get('/categories', (req, res) => {
  if (!cache.categories) {
    refreshCategories().catch(() => {});
    return res.json({ success: true, categories: DOUBAN_TAGS, cached: false });
  }
  if (isStale(cache.categories)) {
    refreshCategories().catch(() => {});
  }
  res.json({ success: true, categories: cache.categories.categories, cached: true });
});

// GET /api/news/cache-status
router.get('/cache-status', (req, res) => {
  res.json({
    success: true,
    home: cache.home ? { age: Math.round(cacheAge(cache.home) / 1000) + 's', count: (cache.home.articles || []).length } : null,
    categories: cache.categories ? { age: Math.round(cacheAge(cache.categories) / 1000) + 's' } : null,
    refreshInterval: REFRESH_INTERVAL / 1000 + 's',
    source: 'douban.com'
  });
});

// GET /api/news/category/:slug - movies by tag
router.get('/category/:slug', async (req, res) => {
  const slug = req.params.slug;
  const tagInfo = DOUBAN_TAGS.find(t => t.slug === slug);

  if (!tagInfo) {
    return res.status(404).json({ success: false, error: 'Category not found' });
  }

  const entry = cache.categoryPages[slug];

  if (entry && !isStale(entry)) {
    return res.json({ success: true, articles: entry.articles.slice(0, 30), source: 'douban.com', cached: true });
  }

  try {
    const movies = await fetchDoubanMovies(tagInfo.tag, 30);
    const articles = movies.map(m => subjectToArticle(m, tagInfo.name));
    cache.categoryPages[slug] = { articles, timestamp: Date.now() };
    console.log('[DoubanCache] Category ' + slug + ' refreshed: ' + articles.length + ' items');
    res.json({ success: true, articles: articles.slice(0, 30), source: 'douban.com' });
  } catch (err) {
    const staleEntry = cache.categoryPages[slug];
    if (staleEntry && staleEntry.articles.length) {
      return res.json({ success: true, articles: staleEntry.articles.slice(0, 30), source: 'douban.com', cached: true, stale: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/article/:id - subject detail
router.get('/article/:id', async (req, res) => {
  try {
    const subjectId = req.params.id.replace(/[^0-9]/g, '');
    if (!subjectId) {
      return res.status(400).json({ success: false, error: 'Invalid subject ID' });
    }

    const detail = await fetchSubjectDetail(subjectId);

    // Also get basic info from search API
    const url = DOUBAN_API + '/search_subjects?type=movie&q=' + subjectId + '&page_limit=1';
    const data = await fetchJson(url);
    const subject = (data.subjects || []).find(s => s.id === subjectId);

    const article = {
      title: subject ? subject.title : '',
      date: '',
      source: '豆瓣电影',
      category: '电影详情',
      content: (detail.summary || '暂无简介') + '\n\n' +
        (detail.directors.length ? '导演: ' + detail.directors.join(', ') + '\n' : '') +
        (detail.actors.length ? '主演: ' + detail.actors.join(', ') : ''),
      images: subject ? [subject.cover] : [],
      rating: subject ? subject.rate : ''
    };

    res.json({ success: true, article, source: 'douban.com' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/image-proxy - proxy Douban images
router.get('/image-proxy', (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl || !imgUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const client = imgUrl.startsWith('https') ? https : require('http');
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://movie.douban.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    rejectUnauthorized: false
  };

  client.get(imgUrl, opts, (imgRes) => {
    if (imgRes.statusCode !== 200) {
      return res.status(imgRes.statusCode).end();
    }
    const contentType = imgRes.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', () => res.status(500).end());
});

module.exports = router;
