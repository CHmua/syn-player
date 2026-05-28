const axios = require('axios');
const https = require('https');
const http = require('http');
const urlLib = require('url');

// ============================================================
//  m3u8 Proxy System — the core of the entire streaming stack
//  Handles: Referer spoofing, CORS, AES-128 keys, .ts rewrite, 302 follow
// ============================================================

const PROXY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Build a custom axios instance that follows redirects and spoofs headers
function createProxyClient(referer) {
  return axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': PROXY_USER_AGENT,
      'Referer': referer || '',
      'Origin': referer ? new URL(referer).origin : '',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    // Need to handle redirects manually for some edge cases
    validateStatus: status => status >= 200 && status < 400
  });
}

// --------------- Proxy: .m3u8 playlist ---------------
// Known referer overrides for CDNs that check specific origins
const REFERER_FALLBACKS = {
  'ppqrrs.com': ['https://api.wujinapi.com/', 'https://wujinzy.com/'],
  'lz-cdn': ['https://dbzy.tv/'],
  'oag7h.com': ['https://dbzy.tv/'],
  'bfvvs.com': ['https://hongniuziyuan.com/', 'https://www.hongniuzy3.com/'],
  'youkupic.com': ['https://api.wujinapi.com/'],
  'prrrs.com': ['https://api.wujinapi.com/']
};

function getFallbackReferers(url) {
  const hostname = new URL(url).hostname;
  for (const [pattern, referers] of Object.entries(REFERER_FALLBACKS)) {
    if (hostname.includes(pattern)) return referers;
  }
  return [];
}

async function fetchWithRetry(targetUrl, referer, options = {}) {
  const referers = [referer, ...getFallbackReferers(targetUrl)];
  let lastErr = null;

  for (const ref of referers) {
    try {
      const client = createProxyClient(ref);
      const response = await client.get(targetUrl, { responseType: 'text', ...options });
      return { response, referer: ref };
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.status === 403) continue;
      if (err.code === 'ERR_BAD_REQUEST' || err.code === 'ECONNREFUSED') continue;
      throw err;
    }
  }
  throw lastErr;
}

// Segment proxy: retry up to 2 times with increasing backoff
async function fetchSegmentWithRetry(targetUrl, referer, retries = 2) {
  const referers = [referer, ...getFallbackReferers(targetUrl)];
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const ref of referers) {
      try {
        const client = createProxyClient(ref);
        const response = await client.get(targetUrl, {
          responseType: 'stream',
          timeout: 45000
        });
        return { response, referer: ref };
      } catch (err) {
        lastErr = err;
        if (err.response && err.response.status === 403) continue;
        if (err.code === 'ERR_BAD_REQUEST' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') continue;
        if (attempt < retries) break; // retry on transient errors
        throw err;
      }
    }
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 300 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

function isM3U8Text(payload) {
  const text = String(payload || '');
  if (!text) return false;
  return /#EXTM3U/i.test(text) || /#EXTINF/i.test(text);
}

function looksLikeHtmlPayload(payload, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return true;
  const head = String(payload || '').slice(0, 300).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

function normalizeMediaUrl(raw, baseUrl) {
  if (!raw) return '';
  const cleaned = String(raw)
    .trim()
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  if (!cleaned) return '';
  return resolveUrl(cleaned, baseUrl);
}

function looksLikePlaylistUrl(url) {
  const low = String(url || '').toLowerCase();
  if (!low) return false;
  if (low.includes('.m3u8') || low.includes('.m3u')) return true;
  return /\/(share|play)\//.test(low);
}

function looksLikeSegmentUrl(url) {
  return /\.(ts|m4s|m4a|aac|mp4|flv|mp3|key)(?:$|[?#])/i.test(String(url || ''));
}

function extractCandidatesFromHtml(html, pageUrl) {
  const body = String(html || '');
  if (!body) return [];

  const patterns = [
    /"url"\s*:\s*"([^"]+)"/gi,
    /var\s+main\s*=\s*"([^"]+)"/gi,
    /var\s+mp4\s*=\s*"([^"]+)"/gi,
    /video\s*:\s*\{[\s\S]{0,300}?url\s*:\s*['"]([^'"]+)['"]/gi,
    /https?:\/\/[^"'\\\s]+(?:\.m3u8|\.mp4|\.flv)(?:\?[^"'\\\s]*)?/gi,
    /['"]((?:\/|\.\/|\.\.\/)[^'"]+\.(?:m3u8|mp4|flv)(?:\?[^'"]*)?)['"]/gi
  ];

  const candidates = [];
  const seen = new Set();
  const baseUrl = getBaseUrl(pageUrl);
  const push = (value) => {
    const normalized = normalizeMediaUrl(value, baseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const value = match[1] || match[0];
      push(value);
      if (candidates.length >= 16) break;
    }
    if (candidates.length >= 16) break;
  }

  candidates.sort((a, b) => {
    const as = a.toLowerCase();
    const bs = b.toLowerCase();
    const score = (u) => (u.includes('.m3u8') || u.includes('.m3u')) ? 2 : (u.includes('.mp4') || u.includes('.flv')) ? 1 : 0;
    return score(bs) - score(as);
  });

  return candidates;
}

async function proxyM3U8(req, res, targetOverride, depth = 0, refererOverride) {
  const targetUrl = targetOverride || req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });
  if (depth > 4) throw new Error('Resolve depth exceeded');

  try {
    const referer = refererOverride || req.query.referer || extractReferer(targetUrl);
    const { response, referer: usedReferer } = await fetchWithRetry(targetUrl, referer);
    let playlist = String(response.data || '');

    if (!isM3U8Text(playlist)) {
      if (looksLikeHtmlPayload(playlist, response.headers && response.headers['content-type'])) {
        const candidates = extractCandidatesFromHtml(playlist, targetUrl);
        for (const candidate of candidates) {
          if (!candidate || candidate === targetUrl) continue;
          if (looksLikePlaylistUrl(candidate)) {
            try {
              return await proxyM3U8(req, res, candidate, depth + 1, usedReferer);
            } catch {
              // continue probing the next candidate
            }
            continue;
          }
          if (looksLikeSegmentUrl(candidate)) {
            return proxySegment(req, res, candidate, depth + 1, usedReferer);
          }
        }
      }
      throw new Error(`Upstream did not return m3u8: ${targetUrl}`);
    }

    // Rewrite all non-comment media/resource lines to go through our proxy.
    const baseUrl = getBaseUrl(targetUrl);
    const proxyBase = `${req.protocol}://${req.get('host')}/api/vod/m3u8-proxy?referer=${encodeURIComponent(usedReferer)}&url=`;

    playlist = playlist.replace(/^(?!#)(.+)$/gm, (match, line) => {
      const fileUri = String(line || '').trim();
      if (!fileUri) return match;
      const absolute = resolveUrl(fileUri, baseUrl);
      return absolute ? `${proxyBase}${encodeURIComponent(absolute)}` : match;
    });

    // Rewrite URI="" in EXT-X-KEY/EXT-X-MAP for key/init segment proxying.
    playlist = playlist.replace(/URI="([^"]+)"/g, (match, keyUri) => {
      const absolute = resolveUrl(keyUri, baseUrl);
      return `URI="${proxyBase}${encodeURIComponent(absolute)}"`;
    });

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.send(playlist);
  } catch (err) {
    console.error(`[m3u8-Proxy] Failed: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch m3u8', detail: err.message });
  }
}

// --------------- Proxy: .ts segments and .key files ---------------
async function proxySegment(req, res, targetOverride, _depth = 0, refererOverride) {
  const targetUrl = targetOverride || req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const referer = refererOverride || req.query.referer || extractReferer(targetUrl);
    const { response } = await fetchSegmentWithRetry(targetUrl, referer);

    const contentType = response.headers['content-type'] || 'video/mp2t';
    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': response.headers['content-length'] || ''
    });

    // Handle stream errors gracefully
    response.data.on('error', function(err) {
      if (!res.headersSent) {
        res.status(502).end();
      }
    });

    response.data.pipe(res);
  } catch (err) {
    console.error(`[Segment-Proxy] Failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to fetch segment', detail: err.message });
    }
  }
}

// --------------- Unified proxy handler (auto-detect type) ---------------
async function proxyHandler(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  if (looksLikeSegmentUrl(targetUrl)) {
    return proxySegment(req, res);
  }
  // Non-segment URLs (including /share/* and /play/* pages) are resolved as playlists first.
  return proxyM3U8(req, res);
}

// --------------- Utility functions ---------------

function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
  } catch {
    return url.substring(0, url.lastIndexOf('/') + 1);
  }
}

function resolveUrl(uri, baseUrl) {
  if (!uri) return '';
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (uri.startsWith('//')) return 'https:' + uri;
  if (uri.startsWith('/')) {
    try {
      const u = new URL(baseUrl);
      return u.origin + uri;
    } catch { return uri; }
  }
  return baseUrl + uri;
}

function extractReferer(url) {
  try {
    const u = new URL(url);
    return u.origin + '/';
  } catch { return ''; }
}

module.exports = { proxyHandler, proxyM3U8, proxySegment };
