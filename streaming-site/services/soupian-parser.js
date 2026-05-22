const axios = require('axios');
const cheerio = require('cheerio');

// ============================================================
//  Soupian.pro (搜片.com) Meta-Search Parser
//  Aggregates video metadata, posters, and external playback
//  links from soupian.pro's search/detail pages.
//
//  soupian.pro is a meta-engine — it indexes many video sites
//  and links to them for actual playback. This parser extracts:
//  1. Search results (title, poster, year, type)
//  2. Detail page with all external playback source links
//  3. Homepage trending content
// ============================================================

const BASE_URL = 'https://soupian.pro';
const TIMEOUT = 15000;

function createClient() {
  return axios.create({
    timeout: TIMEOUT,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    maxRedirects: 5
  });
}

// --------------- Search soupian.pro ---------------
// Returns array of { vod_id, vod_name, vod_pic, vod_year, vod_type, source_url }
async function searchSoupian(keyword) {
  const client = createClient();
  try {
    const encoded = encodeURIComponent(keyword);
    const url = `${BASE_URL}/movie/${encoded}`;
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    const results = [];

    // Parse each source row — each represents one external site that has this content
    $('.list-row, .source-item, [class*="list-w"]').each((i, el) => {
      const link = $(el).find('a[target="_blank"]').first();
      const href = link.attr('href') || '';
      const title = link.attr('title') || link.text().trim() || '';
      const img = $(el).find('img[data-url]').first();
      const posterProxy = img.attr('data-url') || '';
      // Extract original poster URL from soupian proxy
      const posterOriginal = extractOriginalPosterUrl(posterProxy);
      const speedEl = $(el).find('.speed');
      const speedUrl = speedEl.attr('data-url') || '';

      // Parse site name from title: "去好看影视播放《狂飙》" → 好看影视
      const siteMatch = title.match(/去(.+?)播放/);
      const siteName = siteMatch ? siteMatch[1] : '';

      // Parse show name from title
      const showMatch = title.match(/《(.+?)》/);
      const showName = showMatch ? showMatch[1] : '';

      // Extract year from context
      const yearMatch = $(el).text().match(/(\d{4})/);
      const year = yearMatch ? yearMatch[1] : '';

      if (href && href.startsWith('http')) {
        results.push({
          vod_id: md5Like(href),
          vod_name: showName || title,
          vod_pic: posterOriginal || posterProxy,
          vod_year: year,
          site_name: siteName,
          playback_url: href,
          speed_test_url: speedUrl || href,
          source: 'soupian'
        });
      }
    });

    // Also parse meta tags for main result metadata
    const metaTitle = $('meta[itemprop="name"]').attr('content') ||
                      $('meta[property="og:title"]').attr('content') || '';
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const metaThumb = $('meta[itemprop="thumbnailUrl"]').attr('content') || '';

    return {
      keyword,
      main_title: metaTitle.replace(/《|》|免费在线观看.*$/g, ''),
      description: metaDesc,
      thumbnail: metaThumb,
      results,
      total: results.length
    };
  } catch (err) {
    console.error(`[Soupian] Search error for "${keyword}":`, err.message);
    return { keyword, results: [], total: 0, error: err.message };
  }
}

// --------------- Get soupian homepage trending ---------------
async function getSoupianHomepage() {
  const client = createClient();
  try {
    const res = await client.get(BASE_URL + '/');
    const $ = cheerio.load(res.data);

    const items = [];

    // Parse poster items from homepage
    $('.poster-item').each((i, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).attr('title') || $(el).find('.poster-item-title').text().trim() || '';
      const img = $(el).find('img[data-url]').first();
      const posterProxy = img.attr('data-url') || '';
      const posterOriginal = extractOriginalPosterUrl(posterProxy);
      const alt = img.attr('alt') || '';

      // Extract name from href: /movie/逐玉 → 逐玉
      const nameFromUrl = decodeURIComponent((href.split('/').pop() || '').replace(/\.html$/, ''));

      items.push({
        vod_id: md5Like(href || nameFromUrl),
        vod_name: alt || title || nameFromUrl,
        vod_pic: posterOriginal || posterProxy,
        detail_url: BASE_URL + href,
        source: 'soupian_homepage'
      });
    });

    return { items, total: items.length };
  } catch (err) {
    console.error('[Soupian] Homepage error:', err.message);
    return { items: [], total: 0 };
  }
}

// --------------- Get detail page with all external sources ---------------
// Returns structured data: { title, poster, sources: [{site_name, playback_url}] }
async function getSoupianDetail(movieName) {
  const client = createClient();
  try {
    const encoded = encodeURIComponent(movieName);
    const url = `${BASE_URL}/movie/${encoded}`;
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    const title = ($('meta[property="og:title"]').attr('content') || movieName)
      .replace(/《|》|免费在线观看.*$/g, '').trim();
    const desc = $('meta[name="description"]').attr('content') || '';
    const thumb = $('meta[itemprop="thumbnailUrl"]').attr('content') || '';

    const sources = [];

    // Each external playback source
    $('.list-row, [class*="playicon"]').each((i, el) => {
      // Look for the play link
      const playLink = $(el).find('a[target="_blank"]').first();
      if (!playLink.length) return;

      const href = playLink.attr('href') || '';
      if (!href.startsWith('http')) return;

      const linkTitle = playLink.attr('title') || '';

      // Parse site name: "去好看影视播放《狂飙》" → 好看影视
      const siteMatch = linkTitle.match(/去(.+?)播放/);
      const siteName = siteMatch ? siteMatch[1] : new URL(href).hostname;

      // Parse show name from title
      const showMatch = linkTitle.match(/《(.+?)》/);
      const showName = showMatch ? showMatch[1] : title;

      // Get poster
      const img = $(el).find('img[data-url]').first();
      const posterProxy = img.attr('data-url') || '';
      const posterOriginal = extractOriginalPosterUrl(posterProxy);

      // Speed test indicator
      const speedEl = $(el).closest('.list-row, .list-w, div').find('.speed');
      const speedUrl = speedEl.attr('data-url') || '';

      sources.push({
        site_name: siteName,
        playback_url: href,
        speed_test_url: speedUrl || href,
        vod_name: showName,
        vod_pic: posterOriginal || posterProxy
      });
    });

    // Deduplicate by playback_url
    const seen = new Set();
    const uniqueSources = sources.filter(s => {
      if (seen.has(s.playback_url)) return false;
      seen.add(s.playback_url);
      return true;
    });

    return {
      vod_name: title,
      vod_content: desc,
      vod_pic: thumb,
      sources: uniqueSources,
      total_sources: uniqueSources.length
    };
  } catch (err) {
    console.error(`[Soupian] Detail error for "${movieName}":`, err.message);
    return { vod_name: movieName, sources: [], total_sources: 0 };
  }
}

// --------------- Batch search multiple keywords ---------------
async function batchSearchSoupian(keywords) {
  const results = await Promise.allSettled(
    keywords.map(kw => searchSoupian(kw))
  );

  const allResults = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.results.length > 0) {
      allResults.push(...r.value.results);
    }
  }

  return allResults;
}

// --------------- Probe: check if an external site has AppleCMS API ---------------
async function probeExternalSiteAPI(playbackUrl) {
  try {
    const url = new URL(playbackUrl);
    // Many of soupian's linked sites are AppleCMS — try their API
    const apiBase = url.origin + '/api.php/provide/vod/?ac=list';
    const client = createClient();
    const res = await client.get(apiBase, { timeout: 8000 });
    if (res.data && (res.data.code === 1 || res.data.code === 200)) {
      return { hasAPI: true, apiUrl: apiBase, type: 'applecms' };
    }
  } catch { /* */ }
  return { hasAPI: false };
}

// --------------- Utilities ---------------

// Extract original poster URL from soupian's proxy URL
// /img/url?src=HASH_OR_URL&w=260 → original URL
function extractOriginalPosterUrl(proxyUrl) {
  if (!proxyUrl) return '';
  const match = proxyUrl.match(/[?&]src=([^&]+)/);
  if (!match) return proxyUrl;
  const src = decodeURIComponent(match[1]);
  // If it's already a full URL, return it
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return src;
  }
  // It's a hash — reconstruct via soupian proxy
  return BASE_URL + '/img/url?src=' + match[1] + '&w=400';
}

// Simple hash for generating vod_ids
function md5Like(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return 'sp_' + Math.abs(hash).toString(36);
}

// ============================================================
//  Pipeline: soupian discovery → external AppleCMS → m3u8 URLs
//  Follows soupian's external links, scrapes playback pages,
//  extracts iframe sources and m3u8 streaming URLs.
// ============================================================

async function enrichSoupianWithStreams(soupianResult, options = {}) {
  const { maxSites = 3, timeout = 30000 } = options;

  let scraper;
  try { scraper = require('./playwright-scraper'); } catch { return soupianResult; }

  const sources = (soupianResult.sources || soupianResult.results || []).slice(0, maxSites);
  const enriched = [];

  for (const source of sources) {
    const playbackUrl = source.playback_url;
    if (!playbackUrl) {
      enriched.push(source);
      continue;
    }

    console.log(`[Pipeline] Scraping ${source.site_name}: ${playbackUrl.substring(0, 60)}`);

    try {
      const detail = await scraper.scrapeDetailPage(playbackUrl, {
        name: source.site_name,
        selectors: {}
      });

      // Build structured play URLs from captured streams
      let vod_play_url = '';
      let vod_play_from = '';

      if (detail && !detail.error) {
        // Priority 1: Captured m3u8 from network
        const m3u8Urls = (detail.network_m3u8 || []).map(r => r.url);
        const mp4Urls = (detail.network_mp4 || []).map(r => r.url);

        if (m3u8Urls.length > 0) {
          // Format: "HD$url1#HD$url2"
          vod_play_url = m3u8Urls.map((u, i) => `HD$${u}`).join('#');
        } else if (mp4Urls.length > 0) {
          vod_play_url = mp4Urls.map((u, i) => `HD$${u}`).join('#');
        }

        // Priority 2: Iframe sources (need further resolution)
        if (!vod_play_url && detail.iframes && detail.iframes.length > 0) {
          // Store iframe URLs — they can be resolved later
          vod_play_url = detail.iframes.map((f, i) => `HD$${f.src}`).join('#');
        }

        // Priority 3: DPlayer config URLs
        if (!vod_play_url && detail.dplayer_configs && detail.dplayer_configs.length > 0) {
          vod_play_url = detail.dplayer_configs.map((u, i) => `HD$${u}`).join('#');
        }

        vod_play_from = source.site_name || '';
      }

      enriched.push({
        ...source,
        vod_play_url,
        vod_play_from,
        _detail: detail ? {
          title: detail.title,
          poster: detail.poster,
          iframes: (detail.iframes || []).length,
          m3u8_count: (detail.network_m3u8 || []).length,
          mp4_count: (detail.network_mp4 || []).length
        } : null
      });

      // Rate limit between sites
      await sleep(2000);

    } catch (err) {
      console.error(`[Pipeline] Error scraping ${source.site_name}:`, err.message);
      enriched.push(source);
    }
  }

  // Also append remaining sources unchanged
  const remaining = (soupianResult.sources || soupianResult.results || []).slice(maxSites);
  enriched.push(...remaining);

  return {
    ...soupianResult,
    sources: enriched,
    results: enriched,
    enriched_count: Math.min(maxSites, (soupianResult.sources || soupianResult.results || []).length)
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  searchSoupian,
  getSoupianHomepage,
  getSoupianDetail,
  batchSearchSoupian,
  probeExternalSiteAPI,
  enrichSoupianWithStreams,
  BASE_URL
};
