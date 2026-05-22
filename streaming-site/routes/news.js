const express = require('express');
const https = require('https');
const http = require('http');
const router = express.Router();

const BASE_URL = 'http://www.glofilm.com';
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ===== In-memory cache =====
var cache = {
  home: null,        // { articles, headlines, timestamp }
  categories: null,  // { categories, timestamp }
  categoryPages: {}  // { [slug]: { articles, timestamp } }
};

function cacheAge(entry) {
  return entry ? Date.now() - entry.timestamp : Infinity;
}

function isStale(entry) {
  return cacheAge(entry) > REFRESH_INTERVAL;
}

async function refreshHome() {
  try {
    var html = await fetchHtml(BASE_URL + '/');
    var articles = parseArticles(html);
    var headlines = parseHeadlines(html);
    cache.home = { articles: articles, headlines: headlines, timestamp: Date.now() };
    console.log('[NewsCache] Home refreshed: ' + headlines.length + ' headlines, ' + articles.length + ' articles');
  } catch (err) {
    console.error('[NewsCache] Home refresh failed:', err.message);
  }
}

async function refreshCategories() {
  try {
    var html = await fetchHtml(BASE_URL + '/');
    var catRegex = /<a[^>]*href="\/category\/([^"]*\.html)">([^<]*)<\/a>/gi;
    var cats = [];
    var seen = new Set();
    var m;
    while ((m = catRegex.exec(html)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        cats.push({ slug: m[1], name: m[2] });
      }
    }
    cache.categories = { categories: cats, timestamp: Date.now() };
    console.log('[NewsCache] Categories refreshed: ' + cats.length + ' categories');
  } catch (err) {
    console.error('[NewsCache] Categories refresh failed:', err.message);
  }
}

async function refreshAll() {
  console.log('[NewsCache] Starting refresh...');
  await Promise.all([refreshHome(), refreshCategories()]);
}

// Initial load
refreshAll();

// Periodic refresh
setInterval(refreshAll, REFRESH_INTERVAL);

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      rejectUnauthorized: false
    };
    client.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function absUrl(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return BASE_URL + path;
}

function extractImg(html) {
  // Handle both double and single quotes around src
  let m = html.match(/<img[^>]*src="([^"]*)"[^>]*>/i);
  if (!m) m = html.match(/<img[^>]*src='([^']*)'[^>]*>/i);
  return m ? absUrl(m[1]) : '';
}

function parseHeadlines(html) {
  const headlines = [];

  // Isolate hotRecommend block (ends at post-list)
  const hotM = html.match(/<div class="hotRecommend[^"]*">([\s\S]*?)<div class="post-list/);
  if (!hotM) return headlines;
  const hot = hotM[1];

  // Main headline: <div class="pull-left a"> content </div> <div class="pull-left b">
  const mainM = hot.match(/<div class="pull-left a">([\s\S]*?)<\/div>\s*<div class="pull-left b">/);
  if (mainM) {
    const h = mainM[1];
    const linkM = h.match(/<a[^>]*href="(\/article\/\d+\.html)"[^>]*title="([^"]*)"[^>]*>/);
    const dateM = h.match(/(\d{4}-\d{2}-\d{2})/);
    // Last substantial <p> (skip the "xxx 人浏览" line)
    const pAll = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
    let excerpt = '';
    for (let j = pAll.length - 1; j >= 0; j--) {
      const text = pAll[j][1].replace(/<[^>]*>/g, '').trim();
      if (text.length > 20 && !/\d+\s*人浏览/.test(text)) {
        excerpt = text.replace(/\s+/g, ' ').substring(0, 200);
        break;
      }
    }
    if (linkM) {
      headlines.push({
        url: absUrl(linkM[1]),
        title: linkM[2].trim(),
        date: dateM ? dateM[1] : '',
        excerpt: excerpt,
        image: extractImg(h)
      });
    }
  }

  // Sub headlines: <div class="pull-left b"> ... <li> items ... (rest of hot block)
  const subM = hot.match(/<div class="pull-left b">([\s\S]*)$/);
  if (subM) {
    const liRegex = /<li>([\s\S]*?)<\/li>/g;
    let liM;
    while ((liM = liRegex.exec(subM[1])) !== null && headlines.length < 5) {
      const li = liM[1];
      const linkM = li.match(/<a[^>]*href="(\/article\/\d+\.html)"[^>]*title="([^"]*)"[^>]*>/);
      const pM = li.match(/<p>([\s\S]*?)<\/p>/);
      if (linkM) {
        headlines.push({
          url: absUrl(linkM[1]),
          title: linkM[2].trim(),
          date: '',
          excerpt: pM ? pM[1].replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' ').substring(0, 200) : '',
          image: extractImg(li)
        });
      }
    }
  }

  return headlines;
}

function parseArticles(html) {
  const articles = [];

  // Get the <ul> inside post-list which contains all article <li> items
  const ulM = html.match(/<div class="post-list[^"]*">\s*<ul[^>]*>([\s\S]*?)<\/ul>/);
  if (!ulM) return articles;
  const listHtml = ulM[1];

  const liRegex = /<li>([\s\S]*?)<\/li>/g;
  let liM;
  while ((liM = liRegex.exec(listHtml)) !== null) {
    const li = liM[1];

    const linkM = li.match(/<h2[^>]*>\s*<a[^>]*href="(\/article\/\d+\.html)"[^>]*title="([^"]*)"[^>]*>/);
    if (!linkM) continue;

    const dateM = li.match(/(\d{4}-\d{2}-\d{2})/);
    const catM = li.match(/<a[^>]*href="\/category\/([^"]*\.html)">([^<]*)<\/a>/);
    const descM = li.match(/<div class="desc[^"]*">\s*<p>([\s\S]*?)<\/p>/);

    articles.push({
      url: absUrl(linkM[1]),
      title: linkM[2].trim(),
      date: dateM ? dateM[1] : '',
      categorySlug: catM ? catM[1] : '',
      category: catM ? catM[2].trim() : '资讯',
      excerpt: descM ? descM[1].replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' ').substring(0, 150) : '',
      image: extractImg(li)
    });
  }

  return articles;
}

// GET /api/news - serve from cache, auto-refresh if stale
router.get('/', (req, res) => {
  if (!cache.home) {
    return res.status(503).json({ success: false, error: 'Cache not ready, please retry' });
  }
  var page = parseInt(req.query.page) || 1;
  var articles = cache.home.articles || [];
  var headlines = cache.home.headlines || [];

  // Trigger background refresh if stale
  if (isStale(cache.home)) {
    refreshHome().catch(function() {});
  }

  res.json({
    success: true,
    articles: articles.slice(0, 30),
    headlines: headlines,
    source: 'glofilm.com',
    cached: true,
    lastUpdate: new Date(cache.home.timestamp).toISOString()
  });
});

// GET /api/news/categories - serve from cache
router.get('/categories', (req, res) => {
  if (!cache.categories) {
    return res.status(503).json({ success: false, error: 'Cache not ready' });
  }
  if (isStale(cache.categories)) {
    refreshCategories().catch(function() {});
  }
  res.json({ success: true, categories: cache.categories.categories, cached: true });
});

// GET /api/news/cache-status
router.get('/cache-status', (req, res) => {
  res.json({
    success: true,
    home: cache.home ? { age: Math.round(cacheAge(cache.home) / 1000) + 's', count: (cache.home.articles||[]).length } : null,
    categories: cache.categories ? { age: Math.round(cacheAge(cache.categories) / 1000) + 's', count: (cache.categories.categories||[]).length } : null,
    refreshInterval: REFRESH_INTERVAL / 1000 + 's'
  });
});

function parseArticleDetail(html) {
  const result = { title: '', date: '', source: '', category: '', content: '', images: [] };

  const titleM = html.match(/<h1 class="heading">([\s\S]*?)<\/h1>/);
  if (titleM) result.title = titleM[1].replace(/<[^>]*>/g, '').trim();

  const dateM = html.match(/时间[：:]\s*(\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}:\d{2})/);
  if (dateM) result.date = dateM[1];

  const srcM = html.match(/来源[：:]\s*<a[^>]*>([^<]*)<\/a>/);
  if (srcM) result.source = srcM[1].trim();

  const catM = html.match(/<a[^>]*href="\/category\/([^"]*\.html)">([^<]*)<\/a>/);
  if (catM) result.category = catM[2].trim();

  // Extract artCon content
  const artM = html.match(/<div class="artCon">([\s\S]*?)<div class="bdsharebuttonbox/);
  if (!artM) {
    // Try alternate end marker
    const altM = html.match(/<div class="artCon">([\s\S]*?)<\/div>\s*<div/);
    if (altM) {
      result.content = cleanArticleContent(altM[1]);
    }
  } else {
    result.content = cleanArticleContent(artM[1]);
  }

  // Extract image URLs
  const imgRegex = /<img[^>]*src="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    if (!m[1].startsWith('/images/') && !m[1].includes('grey.gif')) {
      result.images.push(m[1]);
    }
  }

  return result;
}

function cleanArticleContent(raw) {
  var cleaned = raw
    // Strip inline font-family and font-size styles
    .replace(/\s*style="[^"]*font-family:[^"]*"/gi, '')
    .replace(/\s*style="[^"]*font-size:[^"]*"/gi, '')
    .replace(/\s*style="[^"]*text-wrap:[^"]*"/gi, '')
    // Remove data-mce-style
    .replace(/\s*data-mce-style="[^"]*"/gi, '')
    // Remove data-mce-src (keep src)
    .replace(/\s*data-mce-src="[^"]*"/gi, '')
    // Remove align, border, vspace attrs
    .replace(/\s+align="[^"]*"/gi, '')
    .replace(/\s+border="[^"]*"/gi, '')
    .replace(/\s+vspace="[^"]*"/gi, '')
    // Keep text-align center style
    .replace(/\s*style="text-align:\s*center;?"/gi, '')
    .trim();

  // Rewrite all image src URLs to use proxy
  cleaned = cleaned.replace(/<img[^>]*src="([^"]*)"([^>]*)>/gi, function(match, src, rest) {
    var proxyUrl = '/api/news/image-proxy?url=' + encodeURIComponent(src);
    return '<img src="' + proxyUrl + '"' + rest + '>';
  });

  // Also handle single-quoted src
  cleaned = cleaned.replace(/<img[^>]*src='([^']*)'([^>]*)>/gi, function(match, src, rest) {
    var proxyUrl = '/api/news/image-proxy?url=' + encodeURIComponent(src);
    return '<img src="' + proxyUrl + '"' + rest + '>';
  });

  return cleaned;
}

// GET /api/news/article/:id - fetch full article detail
router.get('/article/:id', async (req, res) => {
  try {
    const id = req.params.id.replace('.html', '');
    const url = BASE_URL + '/article/' + id + '.html';
    const html = await fetchHtml(url);
    const article = parseArticleDetail(html);

    if (!article.title) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    res.json({ success: true, article: article, source: 'glofilm.com' });
  } catch (err) {
    console.error('Article fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch article', message: err.message });
  }
});

// GET /api/news/category/:slug - serve from cache, fetch if missing or stale
router.get('/category/:slug', async (req, res) => {
  try {
    var slug = req.params.slug;
    var entry = cache.categoryPages[slug];

    if (entry && !isStale(entry)) {
      return res.json({ success: true, articles: entry.articles.slice(0, 30), source: 'glofilm.com', cached: true });
    }

    // Fetch and cache
    var url = BASE_URL + '/category/' + slug;
    var html = await fetchHtml(url);
    var articles = parseArticles(html);

    cache.categoryPages[slug] = { articles: articles, timestamp: Date.now() };
    console.log('[NewsCache] Category ' + slug + ' refreshed: ' + articles.length + ' articles');

    res.json({ success: true, articles: articles.slice(0, 30), source: 'glofilm.com' });
  } catch (err) {
    // Serve stale cache if available
    var entry = cache.categoryPages[req.params.slug];
    if (entry && entry.articles.length) {
      return res.json({ success: true, articles: entry.articles.slice(0, 30), source: 'glofilm.com', cached: true, stale: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/image-proxy?url=... - proxy glofilm images to bypass hotlink protection
router.get('/image-proxy', (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl || !imgUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const client = imgUrl.startsWith('https') ? https : http;
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'http://www.glofilm.com/',
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
    res.setHeader('Cache-Control', 'public, max-age=3600');
    imgRes.pipe(res);
  }).on('error', () => res.status(500).end());
});

module.exports = router;
