// ============================================================
//  Douban Movie Poster & Metadata Scraper
//  Scrapes douban.com search + subject pages (no API key needed)
// ============================================================

const axios = require('axios');
const cache = require('./cache');

const DOUBAN_SEARCH = 'https://www.douban.com/search';
const DOUBAN_SUBJECT = 'https://movie.douban.com/subject';
const DOUBAN_COOKIE = process.env.DOUBAN_COOKIE || '';

const isBlocked = !!DOUBAN_COOKIE ? false : undefined; // unknown until first request if no cookie

const client = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(DOUBAN_COOKIE ? { 'Cookie': DOUBAN_COOKIE } : {})
  },
  maxRedirects: 5
});

// Detect if Douban returned a security/login page instead of real content
function isSecurityPage(html) {
  if (!html || typeof html !== 'string') return true;
  if (html.length < 500) {
    // Short response is not a normal Douban page
    if (html.includes('sec.douban.com') || html.includes('异常请求') || html.includes('登录跳转') || html.includes('有异常请求从你的 IP 发出')) {
      return true;
    }
  }
  if (html.includes('登录跳转页') || html.includes('有异常请求从你的 IP 发出')) {
    return true;
  }
  return false;
}

// --------------- Score how well a search result matches the query ---------------
function scoreMatch(resultTitle, resultYear, query, queryYear) {
  let score = 0;

  // Remove common prefixes/suffixes from query for matching
  const cleanQuery = query.replace(/[第\s]+(\d+)[部季集卷]$/g, ' $1').trim();

  // Title contains query (or vice versa) — high score
  if (resultTitle.includes(cleanQuery) || cleanQuery.includes(resultTitle)) {
    score += 50;
  }

  // Character overlap ratio
  const queryChars = [...new Set(cleanQuery.replace(/\s/g, ''))];
  const titleChars = [...new Set(resultTitle.replace(/\s/g, ''))];
  const overlap = queryChars.filter(c => titleChars.includes(c));
  score += (overlap.length / Math.max(queryChars.length, 1)) * 30;

  // Year match
  if (queryYear && resultYear && queryYear === resultYear) {
    score += 40;
  } else if (queryYear && resultYear && Math.abs(parseInt(queryYear) - parseInt(resultYear)) <= 1) {
    score += 20;
  }

  // Prefer titles with Chinese characters (indicates Chinese title)
  if (/[一-鿿]/.test(resultTitle)) {
    score += 10;
  }

  // Rating bonus
  return score;
}

// Extract year and clean name from query like "死神来了1" or "流浪地球 2019"
function parseQuery(fullQuery) {
  const q = (fullQuery || '').trim();
  // Try "Name Year" pattern
  const yearMatch = q.match(/(\d{4})\s*$/);
  if (yearMatch) {
    return { name: q.substring(0, yearMatch.index).trim(), year: yearMatch[1] };
  }
  // Try "Name N" where N is a sequel number (not a year)
  const numMatch = q.match(/[第\s]*(\d+)\s*$/);
  if (numMatch && parseInt(numMatch[1]) < 100) {
    return { name: q.substring(0, numMatch.index).trim(), num: numMatch[1] };
  }
  return { name: q };
}

// --------------- Search Douban by movie name ---------------
async function searchMovie(name, year) {
  try {
    const parsed = parseQuery(name);
    const searchName = parsed.name || name;
    const searchYear = year || parsed.year || '';

    const { data: html, request } = await client.get(DOUBAN_SEARCH, {
      params: { cat: 1002, q: searchName }
    });

    // Check if Douban blocked the request (security page / login redirect)
    if (isSecurityPage(html)) {
      console.error('[Douban] IP blocked by Douban security — set DOUBAN_COOKIE in .env to bypass. Get your cookie from douban.com after logging in.');
      return null;
    }

    // Douban search result blocks use: <div class="result"><div class="pic">...</div><div class="content">...</div></div>
    // Extract all result blocks by splitting on the result div boundaries
    const blocks = html.split(/<div class="result">/g).slice(1);
    if (blocks.length === 0) return null;

    const candidates = [];

    for (const rawBlock of blocks) {
      // Find the end of this result block (next result or content end marker)
      const block = rawBlock.split(/<div class="result">/)[0];

      // Extract subject ID from onclick handler: sid: 26266893
      const sidMatch = block.match(/sid:\s*(\d+)/);

      // Or from decoded URL in href
      const urlMatch = block.match(/movie\.douban\.com\/subject\/(\d+)/);
      const doubanId = sidMatch ? sidMatch[1] : (urlMatch ? urlMatch[1] : '');

      if (!doubanId) continue;

      // Title: <a class="nbg" ... title="流浪地球">
      const titleMatch = block.match(/<a[^>]*class="nbg"[^>]*title="([^"]*)"/);
      const resultTitle = titleMatch ? titleMatch[1].trim() : searchName;

      // Poster: <img src="https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2545472803.jpg">
      const imgMatch = block.match(/<img[^>]*src="(https:\/\/img\d+\.doubanio\.com\/view\/photo\/[^"]*)"/);

      // Rating: <span class="rating_nums">8.2</span>
      const ratingMatch = block.match(/<span class="rating_nums">([^<]*)<\/span>/);

      // Year from <span class="subject-cast">...2023...</span> or similar
      const numbersInBlock = block.match(/(\d{4})/g);
      const blockYear = numbersInBlock ? numbersInBlock.find(y => parseInt(y) >= 1900 && parseInt(y) <= 2030) : '';

      // Subject-cast: "原名:流浪地球 / 郭帆 / 吴京 / 2019"
      const castMatch = block.match(/<span class="subject-cast"[^>]*>([^<]*)<\/span>/);
      let director = '', actors = '', castYear = '';
      if (castMatch) {
        const parts = castMatch[1].split('/').map(s => s.trim());
        const nonTitle = parts.filter(p => !p.startsWith('原名') && !p.startsWith('又名'));
        if (nonTitle.length >= 2) {
          director = nonTitle[0];
          actors = nonTitle.slice(1, -1).join(', ');
          const last = nonTitle[nonTitle.length - 1];
          if (/^\d{4}$/.test(last)) castYear = last;
          else actors += (actors ? ', ' : '') + last;
        }
      }

      // Description snippet (class="pl")
      const plMatch = block.match(/<p[^>]*class="pl"[^>]*>([^<]*)<\/p>/);
      const snippet = plMatch ? plMatch[1].trim() : '';

      const finalYear = castYear || blockYear || '';

      // Score this result
      const score = scoreMatch(resultTitle, finalYear, searchName, searchYear);

      candidates.push({
        douban_id: doubanId,
        title: resultTitle,
        rating: ratingMatch ? ratingMatch[1].trim() : '',
        poster: imgMatch ? normalizePosterUrl(imgMatch[1]) : '',
        year: finalYear,
        director,
        actors,
        description: snippet,
        score
      });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Try each candidate until we get one with a usable poster
    for (const candidate of candidates) {
      // Get larger poster from subject page if needed
      if (!candidate.poster || candidate.poster.includes('default')) {
        candidate.poster = await getPosterFromSubject(candidate.douban_id);
      }

      if (candidate.poster) {
        return candidate;
      }
    }

    return null;
  } catch (err) {
    console.error('[Douban] Search error:', err.message);
    return null;
  }
}

// --------------- Get poster from subject page ---------------
async function getPosterFromSubject(doubanId) {
  try {
    const { data: html } = await client.get(`${DOUBAN_SUBJECT}/${doubanId}/`);

    if (isSecurityPage(html)) return '';

    // Try og:image meta tag
    const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/);
    if (ogMatch) return normalizePosterUrl(ogMatch[1]);

    // Try mainpic
    const picMatch = html.match(/<img[^>]*id="mainpic"[^>]*src="([^"]*)"/);
    if (picMatch) return normalizePosterUrl(picMatch[1]);

    // Try any large poster image
    const imgMatch = html.match(/<img[^>]*src="([^"]*\.(jpg|jpeg|png|webp))"[^>]*>/i);
    if (imgMatch) return normalizePosterUrl(imgMatch[1]);

    return '';
  } catch (err) {
    console.error('[Douban] Subject error:', err.message);
    return '';
  }
}

// --------------- Get full subject details ---------------
async function getSubjectDetail(doubanId) {
  try {
    const { data: html } = await client.get(`${DOUBAN_SUBJECT}/${doubanId}/`);

    if (isSecurityPage(html)) return null;

    return {
      douban_id: doubanId,
      // Extract from page
      poster: extractMeta(html, 'og:image') || '',
      title: extractMeta(html, 'og:title') || '',
      rating: (html.match(/<strong[^>]*class="ll rating_num"[^>]*>([^<]*)<\/strong>/) || [])[1] || '',
      year: (html.match(/<span[^>]*class="year"[^>]*>\(?(\d{4})\)?<\/span>/) || [])[1] || '',
      director: extractList(html, /<a[^>]*rel="v:directedBy"[^>]*>([^<]*)<\/a>/g),
      actors: extractList(html, /<a[^>]*rel="v:starring"[^>]*>([^<]*)<\/a>/g).slice(0, 5),
      summary: (html.match(/<span[^>]*property="v:summary"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '',
      genres: extractList(html, /<span[^>]*property="v:genre"[^>]*>([^<]*)<\/span>/g)
    };
  } catch (err) {
    console.error('[Douban] Detail error:', err.message);
    return null;
  }
}

// --------------- Enrich a VOD record ---------------
async function enrichVod(vod) {
  if (!vod) return vod;

  const cacheKey = `douban:${vod.vod_name || vod.title || ''}`;
  const cached = await cache.get(cacheKey);
  if (cached) return { ...vod, ...cached };

  const name = (vod.vod_name || vod.title || '').replace(/<[^>]*>/g, '').trim();
  if (!name) return vod;

  try {
    const result = await searchMovie(name, vod.vod_year || vod.year || '');

    if (result && result.douban_id) {
      // Get full details from subject page
      const detail = await getSubjectDetail(result.douban_id) || {};
      const enrichment = {
        douban_id: result.douban_id,
        poster: result.poster || vod.vod_pic || vod.poster || '',
        douban_rating: detail.rating || result.rating || '',
        douban_year: detail.year || '',
        douban_director: detail.director || '',
        douban_actors: detail.actors || [],
        douban_summary: detail.summary || '',
        douban_genres: detail.genres || []
      };

      await cache.set(cacheKey, enrichment, 86400); // 24h
      updateVodDouban(vod.vod_id || vod.id, enrichment);
      return { ...vod, ...enrichment };
    }
  } catch (err) {
    console.error('[Douban] Enrich error:', err.message);
  }

  // Fallback to resource station poster
  await cache.set(cacheKey, { poster: vod.vod_pic || vod.poster || '' }, 3600);
  return vod;
}

// --------------- Batch enrich ---------------
async function enrichVods(vods) {
  if (!vods || vods.length === 0) return vods;

  // Sequential to avoid rate limiting
  const results = [];
  for (const vod of vods) {
    results.push(await enrichVod(vod));
    // Small delay to avoid being blocked
    await sleep(500 + Math.random() * 500);
  }
  return results;
}

// --------------- Helpers ---------------

function normalizePosterUrl(url) {
  if (!url) return '';
  // Douban image URL format: https://imgX.doubanio.com/view/photo/s_ratio_poster/public/pXXXXX.jpg
  // Upgrade "s_ratio_poster" (small) to "l_ratio_poster" (large) for better quality
  return url.replace(/\/view\/photo\/s_ratio_poster\//, '/view/photo/l_ratio_poster/')
            .replace(/\?.*$/, '');
}

function extractMeta(html, property) {
  const match = html.match(new RegExp(`<meta[^>]*property="${property}"[^>]*content="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function extractList(html, regex) {
  const items = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    items.push(m[1].trim());
  }
  return items;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateVodDouban(vodId, data) {
  if (!vodId || !data.douban_id) return;
  try {
    const pool = require('../db');
    await pool.query(
      `UPDATE vods SET
        douban_id = ?,
        douban_rating = IF(? != '', ?, douban_rating),
        poster = IF(poster IS NULL OR poster = '', ?, poster),
        vod_content = IF(? != '', ?, vod_content),
        vod_type = IF(? != '', ?, vod_type),
        vod_director = IF(? != '', ?, vod_director),
        vod_actor = IF(? != '', ?, vod_actor)
      WHERE vod_id = ?`,
      [
        data.douban_id,
        data.douban_rating, data.douban_rating,
        data.poster,
        data.douban_summary, data.douban_summary,
        Array.isArray(data.douban_genres) ? data.douban_genres.join(',') : data.douban_genres,
        Array.isArray(data.douban_genres) ? data.douban_genres.join(',') : data.douban_genres,
        data.douban_director, data.douban_director,
        Array.isArray(data.douban_actors) ? data.douban_actors.join(',') : data.douban_actors,
        Array.isArray(data.douban_actors) ? data.douban_actors.join(',') : data.douban_actors,
        vodId
      ]
    );
  } catch { /* non-critical */ }
}

// --------------- Get full subject details from mobile page ---------------
async function getMobileSubjectDetail(doubanId) {
  try {
    const { data: html } = await client.get(`https://m.douban.com/movie/subject/${doubanId}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(DOUBAN_COOKIE ? { 'Cookie': DOUBAN_COOKIE } : {})
      }
    });

    if (isSecurityPage(html)) {
      console.error('[Douban] Mobile subject blocked — IP flagged by Douban');
      return null;
    }

    // Chinese title from og:title: "永生之太元仙府 (豆瓣)" → "永生之太元仙府"
    let title = '';
    const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/);
    if (ogTitleMatch) {
      title = ogTitleMatch[1]
        .replace(/\s*\(豆瓣\)\s*$/, '')
        .replace(/\s*-\s*豆瓣\s*$/, '')
        .replace(/\s*\[豆瓣\]\s*$/, '')
        .replace(/\s*\([^)]*电视[^)]*\)\s*$/i, '')  // (电视剧) etc
        .replace(/\s*-\s*(?:电视剧|电影|综艺|动漫|纪录片|动画|真人秀)\s*$/, '')
        .replace(/\s+第[一二三四五六七八九十\d]+季\s*$/, '')
        .trim();
    }

    // Rating from meta: <meta itemprop="ratingValue" content="7.9">
    const ratingMatch = html.match(/<meta[^>]*itemprop="ratingValue"[^>]*content="([^"]*)"/);

    // Description from meta: contains "评分：X.X 简介：..."
    let summary = '';
    const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/);
    if (descMatch) {
      // Format: "标题豆瓣评分：7.9 简介：xxx" or just "简介xxx"
      const raw = descMatch[1];
      const introIdx = raw.indexOf('简介：');
      if (introIdx >= 0) {
        summary = raw.substring(introIdx + 3).trim();
      }
    }

    // Genre + duration + area + release date from the info line:
    // "中国大陆 / 科幻 / 冒险 / 灾难 / 2019-02-05(中国大陆)上映 / 片长125分钟"
    let genres = [];
    let duration = '';
    let area = '';
    const infoMatch = html.match(/([^<]+片长(\d+)分钟[^<]*)/);
    if (infoMatch) {
      const infoLine = infoMatch[1];
      const durMatch = infoLine.match(/片长(\d+)分钟/);
      if (durMatch) duration = durMatch[1] + '分钟';

      // Extract genres from the line (parts before "上映" that aren't dates or "片长")
      const parts = infoLine.split('/').map(s => s.trim());
      for (const p of parts) {
        const cleaned = p.replace(/片长\d+分钟/, '').replace(/\(\d{4}-\d{2}-\d{2}[^)]*\)/, '').replace(/上映/, '').trim();
        if (cleaned && !/^\d{4}/.test(cleaned) && !['中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国', '德国', '印度', '泰国', '俄罗斯'].includes(cleaned)) {
          if (cleaned.length <= 4 && !/\d/.test(cleaned)) genres.push(cleaned);
        }
        if (['中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国', '德国', '印度', '泰国', '俄罗斯'].includes(cleaned)) {
          area = cleaned;
        }
      }
    }

    // Also try: data-rating attribute in movie rating section
    const rating2Match = html.match(/"ratingValue":\s*"?([\d.]+)"?/);
    const rating = ratingMatch ? ratingMatch[1] : (rating2Match ? rating2Match[1] : '');

    // Director from meta
    const directorMatch = html.match(/<meta[^>]*name="twitter:data1"[^>]*label="导演"[^>]*content="([^"]*)"/);
    const director = directorMatch ? directorMatch[1] : '';

    return {
      douban_id: doubanId,
      title,
      rating,
      summary,
      genres,
      duration,
      area,
      director
    };
  } catch (err) {
    console.error('[Douban] Mobile detail error:', err.message);
    return null;
  }
}

module.exports = { searchMovie, getSubjectDetail, getMobileSubjectDetail, enrichVod, enrichVods };
