const axios = require('axios');
const xml2js = require('xml2js');
const crypto = require('crypto');

// ============================================================
//  Resource Aggregation Service
//  Multi-source AppleCMS API, timeout/failover, normalize, dedup
// ============================================================

const TIMEOUT = 12000;

// Resource station APIs — AppleCMS standard
const SOURCES = [
  {
    name: 'dbzy',
    label: '豆瓣资源',
    type: 'applecms',
    baseUrl: 'https://dbzy.tv/api.php/provide/vod/',
    timeout: 15000,
    enabled: true
  },
  {
    name: 'wujinzy',
    label: '无尽资源',
    type: 'applecms',
    baseUrl: 'https://api.wujinapi.com/api.php/provide/vod/',
    timeout: 15000,
    enabled: true
  },
  {
    name: 'hongniu',
    label: '红牛资源',
    type: 'applecms',
    baseUrl: 'https://www.hongniuzy3.com/api.php/provide/vod/',
    timeout: 15000,
    enabled: true
  },
  {
    name: 'yjzy',
    label: '永久资源',
    type: 'applecms',
    baseUrl: 'https://yjzy.me/api.php/provide/vod/',
    timeout: 15000,
    enabled: true
  },
  {
    name: 'mtzy',
    label: '每天资源',
    type: 'applecms',
    baseUrl: 'https://mtzy.me/api.php/provide/vod/',
    timeout: 15000,
    enabled: true
  }
];

// --------------- Axios instance ---------------
function createClient(timeout = TIMEOUT) {
  return axios.create({
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*'
    },
    maxRedirects: 10
  });
}

// --------------- XML parser ---------------
const xmlParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });

async function parseXML(text) {
  return xmlParser.parseStringPromise(text);
}

// --------------- Normalize: AppleCMS → unified format ---------------
function normalize(item, sourceName) {
  const vodId = item.vod_id || item.id || '';
  const playUrl = item.vod_play_url || '';

  return {
    vod_id: String(vodId),
    vod_name: (item.vod_name || item.name || item.title || '').replace(/<[^>]*>/g, '').trim(),
    vod_pic: item.vod_pic || item.pic || item.img || '',
    vod_content: (item.vod_content || item.vod_blurb || item.content || item.description || '').replace(/<[^>]*>/g, '').trim(),
    vod_play_url: typeof playUrl === 'string' ? playUrl : JSON.stringify(playUrl),
    vod_remarks: item.vod_remarks || item.remarks || '',
    vod_year: item.vod_year || item.year || '',
    vod_area: item.vod_area || item.area || '',
    vod_lang: item.vod_lang || item.lang || '',
    vod_actor: item.vod_actor || item.actor || '',
    vod_director: item.vod_director || item.director || '',
    vod_score: item.vod_score || item.douban_score || item.score || '0.0',
    vod_type: item.vod_type || item.type || '',
    type_name: item.type_name || item.type || '',
    vod_play_from: item.vod_play_from || '',
    source_name: sourceName,
    douban_id: item.vod_douban_id || ''
  };
}

// --------------- AppleCMS Listing (paginated) ---------------
async function fetchAppleCMSListing(source, page = 1) {
  if (!source.enabled || !source.baseUrl) return { items: [], total: 0, pagecount: 0 };

  const client = createClient(source.timeout || TIMEOUT);
  const params = page > 1 ? `?ac=list&pg=${page}` : '?ac=list';

  try {
    const url = source.baseUrl + params;
    let res;

    if (source.needsChallenge) {
      // Try to bypass JWT challenge
      res = await solveQiqidysChallenge(client, source, params);
    } else {
      res = await client.get(url);
    }

    let data = res.data;

    // Handle variant formats
    // Variant: { code: 200, data: { list, total, pagecount } }
    if (data.code === 200 && data.data) {
      data = { code: 1, ...data.data };
    }
    // Variant: nested in data field
    if (!data.list && data.data && data.data.list) {
      data = { code: data.code || 1, ...data.data };
    }

    // Accept code 1 (standard) or code 200 (variant)
    if (data.code !== 1 && data.code !== 200) {
      console.error(`[Collect] ${source.name} returned code ${data.code}: ${data.msg || ''}`);
      return { items: [], total: 0, pagecount: 0 };
    }

    const list = data.list || [];
    const items = Array.isArray(list) ? list : [list];

    const total = data.total || 0;
    const limit = data.limit || data.pagesize || 20;
    const pagecount = data.pagecount || (total > 0 ? Math.ceil(total / limit) : 1);

    return {
      items: items.map(item => normalize(item, source.name)),
      total,
      pagecount
    };
  } catch (err) {
    // Silent for known-dead sources
    if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT' && err.code !== 'ENOTFOUND') {
      console.error(`[Collect] ${source.name} listing error: ${err.message}`);
    }
    return { items: [], total: 0, pagecount: 0 };
  }
}

// --------------- AppleCMS Search ---------------
async function fetchAppleCMSSearch(source, keyword) {
  if (!source.enabled || !source.baseUrl) return [];

  const client = createClient(source.timeout || TIMEOUT);
  const params = `?ac=search&wd=${encodeURIComponent(keyword)}`;

  try {
    const url = source.baseUrl + params;
    const res = await client.get(url);
    let data = res.data;

    // Handle variant formats
    if (data.code === 200 && data.data) {
      data = { code: 1, ...data.data };
    }
    if (!data.list && data.data && data.data.list) {
      data = { code: data.code || 1, ...data.data };
    }

    if (data.code !== 1 && data.code !== 200) {
      return [];
    }

    const list = data.list || [];
    const items = Array.isArray(list) ? list : [list];
    return items.map(item => normalize(item, source.name));
  } catch (err) {
    if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT' && err.code !== 'ENOTFOUND') {
      console.error(`[Collect] ${source.name} search error: ${err.message}`);
    }
    return [];
  }
}

// --------------- AppleCMS Detail (with play URLs) ---------------
// Supports both single ID and comma-separated IDs (batched)
async function fetchAppleCMSDetail(source, vodIds) {
  if (!source.enabled || !source.baseUrl || !vodIds) return [];

  const client = createClient(source.timeout || TIMEOUT);
  const idsParam = Array.isArray(vodIds) ? vodIds.join(',') : String(vodIds);
  const params = `?ac=videolist&ids=${idsParam}`;

  try {
    const url = source.baseUrl + params;
    const res = await client.get(url);
    let data = res.data;

    // Handle variant formats (same as listing)
    if (data.code === 200 && data.data) {
      data = { code: 1, ...data.data };
    }
    if (!data.list && data.data && data.data.list) {
      data = { code: data.code || 1, ...data.data };
    }

    if (data.code !== 1 && data.code !== 200) {
      console.error(`[Collect] ${source.name} detail error: ${data.msg || ''}`);
      return [];
    }

    const list = data.list || [];
    const items = Array.isArray(list) ? list : [list];
    return items.map(item => normalize(item, source.name));
  } catch (err) {
    console.error(`[Collect] ${source.name} detail error: ${err.message}`);
    return [];
  }
}

// --------------- AppleCMS Category list ---------------
async function fetchAppleCMSCategories(source) {
  if (!source.enabled || !source.baseUrl) return [];

  const client = createClient(source.timeout || TIMEOUT);

  try {
    const url = source.baseUrl + '?ac=list';
    const res = await client.get(url);
    const data = res.data;

    if (data.code !== 1) return [];

    const classes = data.class || [];
    return Array.isArray(classes) ? classes : [classes];
  } catch {
    return [];
  }
}

// --------------- Qiqidys JWT Challenge Solver ---------------
async function solveQiqidysChallenge(client, source, params) {
  // Step 1: Initial request — may return HTML redirect with JWT challenge
  const url = source.baseUrl + params;
  let res = await client.get(url);

  // If we got JSON directly, return it
  if (res.data && typeof res.data === 'object' && res.data.code !== undefined) {
    return res;
  }

  // Step 2: Extract redirect URL from the JS challenge page
  const html = typeof res.data === 'string' ? res.data : '';
  const redirectMatch = html.match(/window\.location\.replace\('([^']+)'\)/);
  if (!redirectMatch) {
    throw new Error('Qiqidys challenge: no redirect found');
  }

  const redirectUrl = redirectMatch[1];
  // Extract sid from redirect URL to use as cookie
  const sidMatch = redirectUrl.match(/sid=([^&]+)/);
  if (sidMatch) {
    client.defaults.headers.Cookie = `sid=${sidMatch[1]}; path=/`;
  }

  // Step 3: Follow the JWT challenge URL
  res = await client.get(redirectUrl, { maxRedirects: 10 });

  // If still HTML, the challenge failed
  if (typeof res.data === 'string' && res.data.includes('<html')) {
    throw new Error('Qiqidys challenge failed: still getting HTML after redirect');
  }

  return res;
}

// --------------- Get listing from ALL sources ---------------
async function getListingsFromAllSources(page = 1) {
  const enabledSources = SOURCES.filter(s => s.enabled && s.baseUrl);

  const results = await Promise.allSettled(
    enabledSources.map(source => fetchAppleCMSListing(source, page))
  );

  const allItems = [];
  let total = 0;
  let pagecount = 0;

  results.forEach((r) => {
    if (r.status === 'fulfilled' && r.value.items.length > 0) {
      allItems.push(...r.value.items);
      total = Math.max(total, r.value.total);
      pagecount = Math.max(pagecount, r.value.pagecount);
    }
  });

  return { items: dedup(allItems), total, pagecount };
}

// --------------- Fetch details for items missing play URLs ---------------
async function fetchMissingDetails(itemIdsBySource) {
  const results = [];

  for (const source of SOURCES) {
    if (!source.enabled || !source.baseUrl) continue;

    const ids = itemIdsBySource[source.name];
    if (!ids || ids.length === 0) continue;

    // Batch up to 10 IDs per request
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const details = await fetchAppleCMSDetail(source, batch);
      results.push(...details);

      // Rate limit between batches
      if (i + 10 < ids.length) {
        await sleep(500);
      }
    }
  }

  return results;
}

// --------------- Sync categories from all sources ---------------
async function syncCategories() {
  const db = require('../db');
  const allClasses = [];

  for (const source of SOURCES) {
    if (!source.enabled || !source.baseUrl) continue;
    // Only AppleCMS sources provide category listings
    if (source.type !== 'applecms') continue;
    const classes = await fetchAppleCMSCategories(source);
    allClasses.push(...classes);
  }

  // Dedup by type_id
  const seen = new Set();
  const unique = allClasses.filter(c => {
    const key = c.type_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Save to categories table
  for (const cat of unique) {
    try {
      await db.query(
        `INSERT INTO categories (name, slug, parent_id, sort_order)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), parent_id = VALUES(parent_id)`,
        [cat.type_name, String(cat.type_id), cat.type_pid || 0, cat.type_id || 0]
      );
    } catch { /* */ }
  }

  return unique;
}

// ============================================================
//  Soupian.pro (搜片.com) HTML scraping adapter
// ============================================================

let _soupianParser = null;
function getSoupianParser() {
  if (!_soupianParser) {
    try {
      _soupianParser = require('./soupian-parser');
    } catch { _soupianParser = null; }
  }
  return _soupianParser;
}

async function fetchSoupianSearch(keyword) {
  const parser = getSoupianParser();
  if (!parser) return [];

  try {
    const data = await parser.searchSoupian(keyword);
    // Normalize to AppleCMS-compatible format
    return (data.results || []).map(item => ({
      vod_id: item.vod_id || ('sp_' + hashStr(item.playback_url || item.vod_name)),
      vod_name: item.vod_name,
      vod_pic: item.vod_pic || '',
      vod_content: data.description || '',
      vod_play_url: '',
      vod_remarks: item.site_name || '',
      vod_year: item.vod_year || '',
      vod_area: '',
      vod_actor: '',
      vod_director: '',
      vod_score: '0.0',
      vod_type: '',
      type_name: '',
      vod_play_from: item.site_name || '',
      source_name: 'soupian',
      // Extra: external playback link (not direct video URL)
      external_playback_url: item.playback_url || ''
    }));
  } catch (err) {
    console.error('[Soupian] Search adapter error:', err.message);
    return [];
  }
}

async function fetchSoupianListing(page) {
  const parser = getSoupianParser();
  if (!parser) return { items: [], total: 0, pagecount: 0 };

  try {
    const data = await parser.getSoupianHomepage();
    const items = (data.items || []).map(item => ({
      vod_id: item.vod_id,
      vod_name: item.vod_name,
      vod_pic: item.vod_pic || '',
      vod_content: '',
      vod_play_url: '',
      vod_remarks: '',
      vod_year: '',
      vod_area: '',
      vod_actor: '',
      vod_director: '',
      vod_score: '0.0',
      vod_type: '',
      type_name: '',
      vod_play_from: '',
      source_name: 'soupian_homepage',
      external_detail_url: item.detail_url || ''
    }));
    return { items, total: items.length, pagecount: 1 };
  } catch (err) {
    console.error('[Soupian] Listing error:', err.message);
    return { items: [], total: 0, pagecount: 0 };
  }
}

// ============================================================
//  HTML sources (Playwright browser scraping) adapter
// ============================================================

let _pwScraper = null;
function getPWScraper() {
  if (!_pwScraper) {
    try {
      _pwScraper = require('./playwright-scraper');
    } catch { _pwScraper = null; }
  }
  return _pwScraper;
}

async function fetchHTMLSourceSearch(source, keyword) {
  const scraper = getPWScraper();
  if (!scraper) return [];

  try {
    const { items } = await scraper.searchHTMLSource(
      { ...source, selectors: { /* auto-detect */ } },
      keyword
    );
    // Normalize to AppleCMS-compatible format
    return items.map(item => ({
      vod_id: item.vod_id,
      vod_name: item.vod_name,
      vod_pic: item.vod_pic || '',
      vod_content: '',
      vod_play_url: item._captured_m3u8?.length > 0
        ? 'HD$' + item._captured_m3u8[0].url : '',
      vod_remarks: '',
      vod_year: '',
      vod_area: '',
      vod_actor: '',
      vod_director: '',
      vod_score: '0.0',
      vod_type: '',
      type_name: '',
      vod_play_from: source.name,
      source_name: source.name,
      detail_url: item.detail_url || '',
      captured_streams: {
        m3u8: item._captured_m3u8 || [],
        mp4: item._captured_mp4 || []
      }
    }));
  } catch (err) {
    console.error(`[HTML:${source.name}] Search error:`, err.message);
    return [];
  }
}

// ============================================================
//  Public API (used by routes and scheduler)
// ============================================================

// Search across ALL enabled sources
async function searchAcrossSources(keyword) {
  const enabledSources = SOURCES.filter(s => s.enabled && s.baseUrl);

  if (enabledSources.length === 0) {
    return { results: [], sources_queried: 0 };
  }

  const results = await Promise.allSettled(
    enabledSources.map(source => fetchAppleCMSSearch(source, keyword))
  );

  const allItems = [];
  results.forEach((r) => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      allItems.push(...r.value);
    }
  });

  // Fallback: if search API returned nothing, try filtering page 1 listings
  if (allItems.length === 0) {
    const fallbackResults = await Promise.allSettled(
      enabledSources.map(source =>
        fetchAppleCMSListing(source, 1).then(r => {
          const kw = keyword.toLowerCase();
          return r.items.filter(item =>
            item.vod_name.toLowerCase().includes(kw)
          );
        })
      )
    );

    fallbackResults.forEach((r) => {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allItems.push(...r.value);
      }
    });
  }

  return {
    results: dedup(allItems),
    sources_queried: enabledSources.length
  };
}

// Get video detail from sources
async function getDetailAcrossSources(vodId) {
  // Only AppleCMS sources support detail lookup by ID
  const apiSources = SOURCES.filter(s => s.enabled && s.type === 'applecms' && s.baseUrl);

  const results = await Promise.allSettled(
    apiSources.map(source => fetchAppleCMSDetail(source, vodId))
  );

  const allItems = [];
  results.forEach(r => {
    if (r.status === 'fulfilled') allItems.push(...r.value);
  });

  return dedup(allItems);
}

// Get soupian detail (external playback links for a movie name)
async function getSoupianDetailForName(movieName) {
  const parser = getSoupianParser();
  if (!parser) return null;

  try {
    return await parser.getSoupianDetail(movieName);
  } catch (err) {
    console.error('[Soupian] Detail error:', err.message);
    return null;
  }
}

// Get Playwright detail page (extract iframes + m3u8 from a playback URL)
async function getHTMLDetailPage(detailUrl, sourceName) {
  const scraper = getPWScraper();
  if (!scraper) return null;

  try {
    const sourceConfig = SOURCES.find(s => s.name === sourceName) || {};
    return await scraper.scrapeDetailPage(detailUrl, sourceConfig);
  } catch (err) {
    console.error(`[HTML:${sourceName}] Detail error:`, err.message);
    return null;
  }
}

// Get recent updates (page-based listing)
async function getRecentUpdates(page = 1) {
  const { items } = await getListingsFromAllSources(page);
  return items;
}

// Get all recent updates from multiple pages
async function getRecentUpdatesMulti(startPage = 1, endPage = 3) {
  const allItems = [];
  for (let page = startPage; page <= endPage; page++) {
    const items = await getRecentUpdates(page);
    allItems.push(...items);
    if (page < endPage) await sleep(300);
  }
  return dedup(allItems);
}

// Fetch full details with play URLs for a list of vod_ids
async function enrichWithPlayUrls(items) {
  // Group item IDs by source
  const idsBySource = {};
  for (const item of items) {
    const sourceName = item.source_name;
    if (!idsBySource[sourceName]) idsBySource[sourceName] = [];
    idsBySource[sourceName].push(item.vod_id);
  }

  return fetchMissingDetails(idsBySource);
}

// --------------- Simple string hash for ID generation ---------------
function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// --------------- Dedup by vod_id ---------------
function dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item.vod_id || seen.has(item.vod_id)) return false;
    seen.add(item.vod_id);
    return true;
  });
}

// Parse m3u8 play URL from vod_play_url field (AppleCMS format)
// Format: "HD$https://xxx.m3u8#BD$https://yyy.m3u8$$$HD$https://aaa.m3u8"
function parsePlayUrls(playUrlStr, playFrom) {
  if (!playUrlStr) return [];

  if (playFrom && String(playUrlStr).includes('$$$')) {
    const lines = parseWithLines(playUrlStr, playFrom);
    const allEpisodes = [];
    for (const line of lines) {
      for (const ep of line.episodes) {
        allEpisodes.push(ep);
      }
    }
    return allEpisodes;
  }

  if (String(playUrlStr).includes('$$$')) {
    const blocks = String(playUrlStr).split('$$$').filter(Boolean);
    const allEpisodes = [];
    for (const block of blocks) {
      const parts = block.split('#').filter(Boolean);
      for (const part of parts) {
        const [name, url] = part.split('$');
        if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//'))) {
          allEpisodes.push({
            episode_name: (name || '默认').trim(),
            play_url: (url.startsWith('//') ? 'https:' + url : url).trim(),
            type: url.includes('.m3u8') ? 'm3u8' : url.includes('.mp4') ? 'mp4' : 'm3u8'
          });
        }
      }
    }
    return allEpisodes;
  }

  const parts = String(playUrlStr).split('#').filter(Boolean);
  return parts.map(part => {
    const [name, url] = part.split('$');
    return { episode_name: (name || '默认').trim(), play_url: (url || '').trim(), type: (url || '').includes('.m3u8') ? 'm3u8' : 'mp4' };
  }).filter(p => p.play_url);
}

// Parse with line awareness: returns array of { source_name, episodes[] }
function parseWithLines(playUrlStr, playFrom) {
  const sourceNames = String(playFrom).split('$$$').map(s => s.trim()).filter(Boolean);
  const blocks = String(playUrlStr).split('$$$').filter(b => b.trim());

  const lines = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    const sourceName = sourceNames[i] || ('线路' + (i + 1));
    const episodes = [];

    const parts = block.split('#').filter(Boolean);
    for (const part of parts) {
      const dollarIdx = part.indexOf('$');
      if (dollarIdx === -1) {
        if (part.startsWith('http')) {
          episodes.push({ episode_name: '默认', play_url: part.trim(), type: 'm3u8' });
        }
        continue;
      }
      const name = part.substring(0, dollarIdx).trim();
      const url = part.substring(dollarIdx + 1).trim();
      if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//'))) {
        episodes.push({
          episode_name: name || '默认',
          play_url: url.startsWith('//') ? 'https:' + url : url,
          type: url.includes('.m3u8') ? 'm3u8' : url.includes('.mp4') ? 'mp4' : 'm3u8'
        });
      }
    }

    if (episodes.length > 0) {
      lines.push({ source_name: sourceName, episodes });
    }
  }

  return lines;
}

// Check m3u8 URL validity (lightweight HEAD request)
async function checkUrlValid(url) {
  try {
    const client = createClient(3000);
    const res = await client.head(url);
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  searchAcrossSources,
  getDetailAcrossSources,
  getSoupianDetailForName,
  getHTMLDetailPage,
  getRecentUpdates,
  getRecentUpdatesMulti,
  getListingsFromAllSources,
  fetchAppleCMSDetail,
  fetchAppleCMSListing,
  fetchAppleCMSSearch,
  fetchAppleCMSCategories,
  fetchSoupianSearch,
  fetchHTMLSourceSearch,
  enrichWithPlayUrls,
  syncCategories,
  parsePlayUrls,
  parseWithLines,
  checkUrlValid,
  normalize,
  dedup,
  hashStr,
  SOURCES
};
