// ============================================================
//  Playwright-based HTML Source Scraper
//  For sites that require JavaScript rendering (anti-bot, SPA)
//
//  Capabilities:
//  1. Launch headless Chromium with stealth profile
//  2. Navigate to target pages, wait for JS challenges to resolve
//  3. Auto-detect video players, iframes, streaming URLs (m3u8/mp4)
//  4. Intercept network requests to catch dynamically loaded video URLs
//  5. Extract OpenGraph / schema.org metadata as fallback
//  6. Normalize results to AppleCMS-compatible format
// ============================================================

// Playwright core comes bundled with @playwright/test
let chromium;
try {
  chromium = require('@playwright/test').chromium;
} catch {
  try {
    chromium = require('playwright-core').chromium;
  } catch {
    chromium = null;
  }
}

// ============================================================
//  Target Site Profiles
//  Define selectors and behavior for each known site.
//  Sites without a profile use auto-detection.
// ============================================================

const HTML_SOURCES = [
  {
    name: 'vcsx',
    label: '星辰影视',
    baseUrl: 'https://www.xn--vcsx1ip8b8w4i.com/',
    type: 'html',
    enabled: true,
    needsBrowser: true,
    // Known selectors (populate after first successful page load)
    selectors: {
      searchInput: 'input[name="searchword"], input[name="wd"], input[type="text"]',
      searchButton: 'button, input[type="submit"], .search-btn',
      videoList: '.video-list, .movie-list, .vodlist, ul.list, .list-box',
      videoItem: 'li, .item, .video-item, .movie-item, a[href*="vod"], a[href*="detail"]',
      videoTitle: '.title, h3, h4, a, .name',
      videoPoster: 'img[src], img[data-src], img[data-url]',
      videoLink: 'a[href*="vod"], a[href*="detail"], a[href*="video"]',
      // Player page
      playerIframe: 'iframe[src*="player"], iframe[src*="play"], iframe[id*="player"]',
      playerVideo: 'video, .video-player, #player, .dplayer',
      // Episode list
      episodeList: '.playlist, .episodes, .url-list, ul.nav',
      episodeItem: 'li, a, button',
    }
  },
  {
    name: 'hhkan',
    label: '哈哈看',
    baseUrl: 'https://www.hhkan0.com/',
    type: 'html',
    enabled: true,
    needsBrowser: true,
    selectors: {
      searchInput: 'input[name="searchword"], input[name="wd"], input[type="text"]',
      searchButton: 'button, input[type="submit"]',
      videoList: '.stui-vodlist, .video-list, ul.list',
      videoItem: 'li, .item, a[href*="vod"]',
      videoTitle: '.title, h3, h4, a',
      videoPoster: 'img[src], img[data-original], img.lazyload',
      videoLink: 'a[href*="vod"], a[href*="detail"]',
      playerIframe: 'iframe[src*="player"], iframe[src*="play"], iframe[id]',
      playerVideo: 'video, #player, .dplayer',
      episodeList: '.playlist, .stui-content__playlist, ul.nav',
      episodeItem: 'li, a',
    }
  },
  {
    name: 'ncat21',
    label: 'ncat21',
    baseUrl: 'https://www.ncat21.com/',
    type: 'html',
    enabled: true,
    needsBrowser: true,
    // Uses auto-detection (same patterns as hhkan)
    selectors: {}
  }
];

// ============================================================
//  Browser Manager — singleton pool
// ============================================================

let browserInstance = null;
let browserContext = null;
let launchLock = false;

const STEALTH_SCRIPT = `
// Remove webdriver detection
Object.defineProperty(navigator, 'webdriver', { get: () => false });
// Fake plugins
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
// Fake languages
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
// Override permissions
const origQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
  parameters.name === 'notifications' ?
    Promise.resolve({ state: Notification.permission }) :
    origQuery(parameters)
);
`;

async function getBrowser() {
  if (!chromium) {
    throw new Error('Playwright not available. Install: npm install @playwright/test && npx playwright install chromium');
  }

  if (browserInstance && browserInstance.isConnected()) {
    return { browser: browserInstance, context: browserContext };
  }

  if (launchLock) {
    // Wait for another caller to finish launching
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (browserInstance && browserInstance.isConnected()) {
        return { browser: browserInstance, context: browserContext };
      }
    }
    throw new Error('Browser launch timeout');
  }

  launchLock = true;
  try {
    console.log('[Playwright] Launching browser...');
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
      ]
    });

    browserContext = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      // Ignore HTTPS errors for some self-signed sites
      ignoreHTTPSErrors: true,
    });

    // Inject stealth script on every page
    await browserContext.addInitScript(STEALTH_SCRIPT);

    console.log('[Playwright] Browser launched successfully');
    return { browser: browserInstance, context: browserContext };
  } finally {
    launchLock = false;
  }
}

async function closeBrowser() {
  try {
    if (browserContext) { await browserContext.close(); browserContext = null; }
    if (browserInstance) { await browserInstance.close(); browserInstance = null; }
    console.log('[Playwright] Browser closed');
  } catch { /* */ }
}

// ============================================================
//  Network Request Interception — catch m3u8/mp4 URLs
// ============================================================

function setupNetworkInterceptor(page) {
  const capturedUrls = {
    m3u8: [],
    mp4: [],
    mpd: [],
    flv: [],
    api: [],
    other: []
  };

  page.on('request', (request) => {
    const url = request.url();
    const lower = url.toLowerCase();

    if (lower.includes('.m3u8') || lower.includes('.m3u')) {
      capturedUrls.m3u8.push({ url, headers: request.headers(), timestamp: Date.now() });
    } else if (lower.includes('.mp4')) {
      capturedUrls.mp4.push({ url, timestamp: Date.now() });
    } else if (lower.includes('.mpd')) {
      capturedUrls.mpd.push({ url, timestamp: Date.now() });
    } else if (lower.includes('.flv')) {
      capturedUrls.flv.push({ url, timestamp: Date.now() });
    } else if (lower.includes('/api.php') || lower.includes('/api/') || lower.includes('/ajax/')) {
      capturedUrls.api.push({ url, timestamp: Date.now() });
    }
  });

  // Also capture response headers that might indicate video
  page.on('response', (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    if (contentType.includes('video/') || contentType.includes('application/vnd.apple.mpegurl')) {
      const lower = url.toLowerCase();
      if (!capturedUrls.m3u8.find(r => r.url === url) && !capturedUrls.mp4.find(r => r.url === url)) {
        if (lower.includes('m3u8')) capturedUrls.m3u8.push({ url, contentType, timestamp: Date.now() });
        else capturedUrls.mp4.push({ url, contentType, timestamp: Date.now() });
      }
    }
  });

  return capturedUrls;
}

// ============================================================
//  Auto-Detection: find video player on any page
// ============================================================

async function autoDetectPlayer(page) {
  return page.evaluate(() => {
    const results = {
      iframes: [],
      videos: [],
      players: [],
      dplayerConfigs: [],
      scripts: []
    };

    // Find iframes (most common for video players)
    document.querySelectorAll('iframe').forEach((iframe, i) => {
      const src = iframe.src || iframe.getAttribute('data-src') || '';
      if (src && (src.includes('player') || src.includes('play') || src.includes('m3u8') ||
          src.includes('qq.com') || src.includes('youku') || src.includes('iqiyi') ||
          src.includes('bilibili') || src.includes('tudou') || src.includes('mgtv') ||
          src.includes('163.com') || src.includes('pptv'))) {
        results.iframes.push({ index: i, src, id: iframe.id, name: iframe.name });
      }
    });

    // If no player iframes found, grab ALL iframes
    if (results.iframes.length === 0) {
      document.querySelectorAll('iframe').forEach((iframe, i) => {
        const src = iframe.src || iframe.getAttribute('data-src') || '';
        if (src && src.startsWith('http')) {
          results.iframes.push({ index: i, src, id: iframe.id, name: iframe.name });
        }
      });
    }

    // Find direct <video> elements
    document.querySelectorAll('video').forEach((video, i) => {
      const sources = [];
      video.querySelectorAll('source').forEach(s => sources.push(s.src));
      results.videos.push({
        index: i,
        src: video.src || video.getAttribute('data-src') || '',
        sources,
        poster: video.poster || ''
      });
    });

    // Find common player wrappers
    ['#player', '.dplayer', '#dplayer', '.video-player', '#video-player',
     '.MacPlayer', '#MacPlayer', '.player-wrapper', '.play-box', '#play-box',
     '.stui-player, #bofang, .bofang, .player-container'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) {
        const iframes = el.querySelectorAll('iframe');
        const videos = el.querySelectorAll('video');
        if (iframes.length || videos.length) {
          results.players.push({
            selector: sel,
            hasIframes: iframes.length,
            hasVideo: videos.length
          });
        }
      }
    });

    // Try to find DPlayer / other player configs in scripts
    document.querySelectorAll('script').forEach(script => {
      const text = script.textContent || script.innerText || '';
      if (text.includes('dp') && (text.includes('url') || text.includes('video'))) {
        // Extract URL patterns from player configs
        const matches = text.match(/(?:url|video|src)\s*[:=]\s*['"]([^'"]+)['"]/g);
        if (matches) {
          results.dplayerConfigs.push(...matches.map(m => {
            const val = m.replace(/^(?:url|video|src)\s*[:=]\s*['"]/, '').replace(/['"]$/, '');
            return val;
          }));
        }
      }
    });

    return results;
  });
}

// ============================================================
//  Metadata Extraction — OpenGraph, schema.org, meta tags
// ============================================================

async function extractMetadata(page) {
  return page.evaluate(() => {
    const meta = {};

    // OpenGraph
    meta.og_title = document.querySelector('meta[property="og:title"]')?.content || '';
    meta.og_image = document.querySelector('meta[property="og:image"]')?.content || '';
    meta.og_description = document.querySelector('meta[property="og:description"]')?.content || '';

    // Schema.org
    meta.schema_name = document.querySelector('meta[itemprop="name"]')?.content || '';
    meta.schema_image = document.querySelector('meta[itemprop="image"]')?.content || '';
    meta.schema_thumbnail = document.querySelector('meta[itemprop="thumbnailUrl"]')?.content || '';

    // Standard meta
    meta.title = document.title || '';
    meta.description = document.querySelector('meta[name="description"]')?.content || '';
    meta.keywords = document.querySelector('meta[name="keywords"]')?.content || '';

    // Structured data
    const ldJson = document.querySelector('script[type="application/ld+json"]');
    if (ldJson) {
      try { meta.ld_json = JSON.parse(ldJson.textContent); } catch { /* */ }
    }

    // Try to find the main movie/show title from common patterns
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const h2 = document.querySelector('h2')?.textContent?.trim() || '';
    meta.page_title = h1 || h2 || meta.og_title || meta.title;

    return meta;
  });
}

// ============================================================
//  Core scraping functions
// ============================================================

// Search a site for content
async function searchHTMLSource(sourceConfig, keyword) {
  if (!sourceConfig.enabled || !sourceConfig.needsBrowser) return { items: [] };

  let page = null;
  try {
    const { context } = await getBrowser();
    page = await context.newPage();

    // Set up network capture
    const networkCapture = setupNetworkInterceptor(page);

    const startUrl = sourceConfig.baseUrl;
    console.log(`[Playwright:${sourceConfig.name}] Navigating to ${startUrl}`);

    await page.goto(startUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for JS challenges to resolve (filejin.ru PoW, Cloudflare, etc.)
    // Give the page up to 20 seconds to settle
    try {
      await page.waitForFunction(() => {
        // Check if any challenge overlay is gone
        const challenges = document.querySelectorAll('[id*="challenge"], .verify-card, #cf-challenge, .pow-form');
        if (challenges.length === 0) return true;
        // Check if page has actual content beyond challenges
        const body = document.body.innerText || '';
        return body.length > 500 && !body.includes('安全验证') && !body.includes('Just a moment');
      }, { timeout: 20000 });
    } catch {
      // If challenge doesn't resolve, try to work with what we have
      console.log(`[Playwright:${sourceConfig.name}] Challenge may not have resolved, attempting to proceed...`);
    }

    // Wait a bit more for dynamic content
    await sleep(3000);

    // Try to search if keyword provided
    const sel = sourceConfig.selectors || {};
    if (keyword) {
      const searchInput = await page.$(sel.searchInput || 'input[type="text"]');
      if (searchInput) {
        await searchInput.fill(keyword);
        const searchBtn = await page.$(sel.searchButton || 'button, input[type="submit"]');
        if (searchBtn) {
          await searchBtn.click();
          await sleep(3000);
        } else {
          await page.keyboard.press('Enter');
          await sleep(3000);
        }
      }
    }

    // Extract video items from the page
    const items = await page.evaluate((selectors) => {
      const results = [];

      // Try known selectors first
      const listSel = selectors.videoList || '.video-list, .movie-list, .vodlist, ul.list, .list-box, .stui-vodlist';
      const itemSel = selectors.videoItem || 'li, .item, .video-item, .movie-item';

      const lists = document.querySelectorAll(listSel);
      lists.forEach(list => {
        const items = list.querySelectorAll(itemSel);
        items.forEach(item => {
          const link = item.querySelector(selectors.videoLink || 'a[href*="vod"], a[href*="detail"], a[href*="video"], a[href*="show"]');
          const img = item.querySelector(selectors.videoPoster || 'img[src], img[data-src], img[data-original], img[data-url]');
          const titleEl = item.querySelector(selectors.videoTitle || '.title, h3, h4, .name, a');

          const href = link?.href || link?.getAttribute('href') || '';
          const title = titleEl?.textContent?.trim() || link?.title || link?.textContent?.trim() || '';
          const poster = img?.src || img?.getAttribute('data-src') || img?.getAttribute('data-original') || img?.getAttribute('data-url') || '';
          const alt = img?.alt || '';

          if (title && title.length > 1) {
            results.push({
              vod_name: title,
              vod_pic: poster,
              detail_url: href.startsWith('http') ? href : '',
              alt: alt
            });
          }
        });
      });

      // Fallback: grab all links that look like video detail pages
      if (results.length === 0) {
        document.querySelectorAll('a').forEach(a => {
          const href = a.href || '';
          const text = a.textContent?.trim() || '';
          const img = a.querySelector('img');
          const poster = img?.src || img?.getAttribute('data-src') || '';

          if (text.length > 2 && text.length < 80 &&
              (href.includes('/vod') || href.includes('/detail') || href.includes('/show') ||
               href.includes('/play') || href.includes('/movie') || href.includes('/video'))) {
            results.push({
              vod_name: text,
              vod_pic: poster,
              detail_url: href
            });
          }
        });
      }

      // Dedup
      const seen = new Set();
      return results.filter(r => {
        const key = r.vod_name + r.detail_url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }, sel);

    // Generate vod_ids
    const itemsWithIds = items.map(item => ({
      ...item,
      vod_id: 'hw_' + sourceConfig.name + '_' + hashStr(item.detail_url || item.vod_name),
      source_name: sourceConfig.name,
      source_label: sourceConfig.label,
      // Add captured network URLs
      _captured_m3u8: networkCapture.m3u8.slice(0, 5),
      _captured_mp4: networkCapture.mp4.slice(0, 5),
    }));

    console.log(`[Playwright:${sourceConfig.name}] Found ${itemsWithIds.length} items, ${networkCapture.m3u8.length} m3u8, ${networkCapture.mp4.length} mp4`);

    return { items: itemsWithIds, networkCapture };
  } catch (err) {
    console.error(`[Playwright:${sourceConfig.name}] Search error:`, err.message);
    return { items: [], error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Scrape a detail/play page for video sources
async function scrapeDetailPage(detailUrl, sourceConfig) {
  if (!detailUrl) return null;

  let page = null;
  try {
    const { context } = await getBrowser();
    page = await context.newPage();
    const networkCapture = setupNetworkInterceptor(page);

    console.log(`[Playwright:${sourceConfig?.name || 'detail'}] Loading ${detailUrl}`);

    await page.goto(detailUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for player to load
    await sleep(5000);

    // Auto-detect player elements
    const playerInfo = await autoDetectPlayer(page);

    // Wait a bit more for late-loading iframes
    await sleep(2000);
    const playerInfo2 = await autoDetectPlayer(page);

    // Merge results
    const allIframes = [...(playerInfo.iframes || []), ...(playerInfo2.iframes || [])];
    const allVideos = [...(playerInfo.videos || []), ...(playerInfo2.videos || [])];
    const allDpConfigs = [...(playerInfo.dplayerConfigs || []), ...(playerInfo2.dplayerConfigs || [])];

    // Extract metadata
    const metadata = await extractMetadata(page);

    // Get episode list if present
    const sel = sourceConfig?.selectors || {};
    const episodes = await page.evaluate((selectors) => {
      const epList = document.querySelector(selectors.episodeList || '.playlist, .episodes, .url-list, ul.nav, .stui-content__playlist');
      if (!epList) return [];

      const items = epList.querySelectorAll(selectors.episodeItem || 'li, a');
      return Array.from(items).map(item => {
        const link = item.tagName === 'A' ? item : item.querySelector('a');
        return {
          episode_name: item.textContent?.trim() || '',
          play_url: link?.href || ''
        };
      }).filter(ep => ep.play_url || ep.episode_name);
    }, sel);

    // Build result
    const result = {
      detail_url: detailUrl,
      title: metadata.page_title || metadata.og_title || metadata.title,
      poster: metadata.og_image || metadata.schema_image || metadata.schema_thumbnail || '',
      description: metadata.og_description || metadata.description || '',
      keywords: metadata.keywords || '',
      iframes: allIframes.filter((v, i, a) => a.findIndex(t => t.src === v.src) === i),
      direct_videos: allVideos,
      dplayer_configs: [...new Set(allDpConfigs)],
      episodes,
      network_m3u8: networkCapture.m3u8.slice(0, 10),
      network_mp4: networkCapture.mp4.slice(0, 10),
      meta: metadata
    };

    console.log(`[Playwright:detail] Extracted: ${result.title}, ${result.iframes.length} iframes, ${result.network_m3u8.length} m3u8, ${result.episodes.length} episodes`);

    return result;
  } catch (err) {
    console.error(`[Playwright:detail] Error:`, err.message);
    return { detail_url: detailUrl, error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Scrape ALL HTML sources (for background collection)
async function scrapeAllHTMLSources(keyword) {
  const enabledSources = HTML_SOURCES.filter(s => s.enabled);

  const results = await Promise.allSettled(
    enabledSources.map(source => searchHTMLSource(source, keyword))
  );

  const allItems = [];
  let totalM3u8 = 0;
  let totalMp4 = 0;

  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.items.length > 0) {
      allItems.push(...r.value.items);
      totalM3u8 += (r.value.networkCapture?.m3u8?.length || 0);
      totalMp4 += (r.value.networkCapture?.mp4?.length || 0);
    }
  });

  return {
    items: allItems,
    sources_queried: enabledSources.length,
    total_m3u8_captured: totalM3u8,
    total_mp4_captured: totalMp4
  };
}

// ============================================================
//  Utilities
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ============================================================
//  Export
// ============================================================

module.exports = {
  HTML_SOURCES,
  getBrowser,
  closeBrowser,
  searchHTMLSource,
  scrapeDetailPage,
  scrapeAllHTMLSources,
  autoDetectPlayer,
  extractMetadata,
  setupNetworkInterceptor
};
