const axios = require('axios');

// ============================================================
//  TVBox Multi-Source JSON Parser
//  Extracts usable AppleCMS / API endpoints from TVBox config JSONs
//  Type 3 (JS parsers) cannot be used server-side — skipped
// ============================================================

const TVBOX_SOURCES = [
  { name: '王小二', url: 'https://9280.kstore.vip/newwex.json' },
  { name: '小盒子4K', url: 'http://xhztv.top/4k.json' },
  { name: '欧歌接口', url: 'https://xn--sdds-rp5imh.v.nxog.top/apitv.php?id=3' },
  { name: '巧技接口', url: 'http://cdn.qiaoji8.com/tvbox.json' },
  { name: '二月红', url: 'https://700sjro44343.vicp.fun/eggp/0211/tv.json' },
  { name: '传说blog', url: 'https://chuanshuo.77blog.cn/tv.json' },
  { name: '俊哥接口', url: 'http://home.jundie.top:81/top98.json' },
  { name: '饭太硬', url: 'https://qist.wyfc.qzz.io/fty.json' },
  { name: '潇洒', url: 'https://qist.wyfc.qzz.io/xiaosa/api.json' },
  { name: '王二小放牛娃', url: 'http://tv.999888987.xyz' },
];

const client = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*'
  }
});

// Clean up common JSON quirks in TVBox configs
function cleanJSON(text) {
  if (typeof text !== 'string') return text;
  // Remove JS comments
  let cleaned = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Fix unescaped control characters in strings
  cleaned = cleaned.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  // Fix trailing commas
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  return cleaned;
}

// Check if a string looks like a usable HTTP API URL
function isAPIUrl(str) {
  if (typeof str !== 'string' || !str) return false;
  return str.startsWith('http://') || str.startsWith('https://');
}

// Check if it's an AppleCMS-compatible endpoint
function isAppleCMSLike(url) {
  return /\/api\.php\//.test(url) ||
         /\/provide\/vod\//.test(url) ||
         /api\.php\/v1\.vod/.test(url) ||
         /\/api\.php\/app\//.test(url);
}

/**
 * Parse a single TVBox JSON and extract usable API endpoints.
 * Returns array of { name, api, type } objects.
 */
async function parseTVBoxSource(sourceConfig) {
  const results = [];
  try {
    const res = await client.get(sourceConfig.url);
    let data = res.data;

    // Try to parse JSON, with cleanup if needed
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        try {
          data = JSON.parse(cleanJSON(data));
        } catch {
          return results;
        }
      }
    }

    const sites = data.sites || [];
    for (const site of sites) {
      const name = site.name || site.key || '';
      const api = site.api || '';
      const ext = site.ext || '';

      // Type 1: direct AppleCMS API
      if (site.type === 1 && isAPIUrl(api)) {
        results.push({
          name: name,
          api: api,
          type: 'applecms',
          source: sourceConfig.name
        });
        continue;
      }

      // Check if api field contains a URL despite being marked as type 3
      if (isAPIUrl(api)) {
        results.push({
          name: name,
          api: api,
          type: isAppleCMSLike(api) ? 'applecms' : 'generic',
          source: sourceConfig.name
        });
      }

      // Check ext field for API URLs (APP-type endpoints)
      if (typeof ext === 'string' && ext.includes('http')) {
        const urlMatch = ext.match(/(https?:\/\/[^\s"']+)/g);
        if (urlMatch) {
          for (const url of urlMatch) {
            if (isAppleCMSLike(url)) {
              results.push({
                name: name,
                api: url,
                type: 'applecms',
                source: sourceConfig.name
              });
            }
          }
        }
      }
    }

    // Also check live TV sources
    if (data.lives && Array.isArray(data.lives)) {
      for (const live of data.lives) {
        if (isAPIUrl(live.url)) {
          results.push({
            name: live.name || live.group || '直播源',
            api: live.url,
            type: 'live',
            source: sourceConfig.name
          });
        }
      }
    }

  } catch (err) {
    // Source may be temporarily down — silently skip
  }
  return results;
}

/**
 * Parse ALL TVBox sources and return deduplicated API endpoints.
 */
async function parseAllTVBoxSources() {
  const allEndpoints = [];
  const results = await Promise.allSettled(
    TVBOX_SOURCES.map(s => parseTVBoxSource(s))
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      allEndpoints.push(...r.value);
    }
  }

  // Dedup by API URL
  const seen = new Set();
  const unique = allEndpoints.filter(ep => {
    const key = ep.api;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Log discovery
  const applecms = unique.filter(ep => ep.type === 'applecms');
  if (applecms.length > 0) {
    console.log(`[TVBox] Discovered ${applecms.length} AppleCMS endpoints from ${TVBOX_SOURCES.length} sources`);
  }

  return { all: unique, applecms, totalSources: TVBOX_SOURCES.length };
}

module.exports = { parseTVBoxSource, parseAllTVBoxSources, TVBOX_SOURCES };
