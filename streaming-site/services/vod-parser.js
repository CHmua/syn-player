// ============================================================
//  VOD Source Parser — AppleCMS $$$ / # / $ format
//  Parses vod_play_from + vod_play_url into structured sources
// ============================================================

const crypto = require('crypto');
const { checkUrlValid } = require('./collect');

const cache = require('./cache');

// --------------- Main parser: AppleCMS format ---------------

/**
 * Parse AppleCMS play URL structure:
 *   vod_play_from: "量子$$$非凡$$$暴风"
 *   vod_play_url:  "HD$https://a.com/1.m3u8#BD$https://a.com/2.m3u8$$$HD$https://b.com/1.m3u8$$$HD$https://c.com/1.m3u8"
 *
 * Rules:
 *   $$$ separates source lines
 *   #   separates episodes within a source
 *   $   separates episode name from URL
 */
function parseAppleCMS(playFrom, playUrl) {
  if (!playUrl) return [];

  const sourceNames = (playFrom || '').split('$$$').map(s => s.trim()).filter(Boolean);
  const sourceBlocks = String(playUrl).split('$$$').filter(block => block.trim());

  const sources = [];

  for (let i = 0; i < sourceBlocks.length; i++) {
    const block = sourceBlocks[i].trim();
    if (!block) continue;

    const sourceName = sourceNames[i] || ('线路' + (i + 1));
    const sourceCode = generateSourceCode(sourceName, i);

    const episodeParts = block.split('#').filter(Boolean);
    const episodes = [];

    for (const part of episodeParts) {
      const dollarIdx = part.indexOf('$');
      if (dollarIdx === -1) {
        // No $ separator — treat entire part as URL
        const url = part.trim();
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          episodes.push({
            episode_name: '默认',
            play_url: url,
            type: detectType(url)
          });
        }
        continue;
      }

      const name = part.substring(0, dollarIdx).trim();
      const url = part.substring(dollarIdx + 1).trim();

      if (!url) continue;
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('//')) continue;

      const normalizedUrl = url.startsWith('//') ? 'https:' + url : url;

      episodes.push({
        episode_name: name || '默认',
        play_url: normalizedUrl,
        type: detectType(normalizedUrl)
      });
    }

    if (episodes.length > 0) {
      sources.push({
        source_name: sourceName,
        source_code: sourceCode,
        episodes
      });
    }
  }

  return sources;
}

// --------------- Detect video type ---------------

function detectType(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('.m3u')) return 'm3u8';
  if (lower.includes('.mp4')) return 'mp4';
  if (lower.includes('.mpd')) return 'dash';
  if (lower.includes('.flv')) return 'flv';
  if (lower.includes('youku.com') || lower.includes('tudou.com') || lower.includes('iframe')) return 'iframe';
  return 'm3u8'; // default for most resource stations
}

// --------------- Generate short source code ---------------

function generateSourceCode(name, index) {
  // Try to create a short code from the source name
  const pinyinMap = {
    '量': 'lz', '子': 'lz', '非': 'ff', '凡': 'ff', '暴': 'bf', '风': 'bf',
    '一': 'x1', '二': 'x2', '三': 'x3', '四': 'x4', '五': 'x5',
    '快': 'kj', '速': 'ks', '极': 'js', '光': 'jg', '云': 'ys',
    '雷': 'ly', '电': 'ld', '闪': 'sd', '播': 'bf2', '放': 'ff2',
    '优': 'yk', '酷': 'yk', '腾': 'tx', '讯': 'tx', '爱': 'aq', '奇': 'yi'
  };

  // Extract first character of each Chinese character for code
  let code = '';
  for (const ch of name) {
    if (pinyinMap[ch]) {
      code += pinyinMap[ch];
      break; // Use first character mapping only
    }
  }
  if (!code || code.length < 2) {
    code = 'src' + (index + 1);
  }
  return code.toLowerCase();
}

// --------------- Build full structured video object ---------------

function buildVodObject(vodData) {
  const { vod_id, vod_name, vod_pic, vod_play_from, vod_play_url, vod_content, vod_year, vod_area, vod_remarks } = vodData;

  const sources = parseAppleCMS(vod_play_from, vod_play_url);

  // Generate proxy URLs for all episodes
  for (const source of sources) {
    for (const ep of source.episodes) {
      ep.proxy_url = '/api/vod/m3u8-proxy?url=' + encodeURIComponent(ep.play_url);
    }
  }

  return {
    vod_id,
    vod_name,
    poster: vod_pic || '',
    content: vod_content || '',
    year: vod_year || '',
    area: vod_area || '',
    remarks: vod_remarks || '',
    sources,
    total_sources: sources.length,
    total_episodes: sources.reduce((sum, s) => sum + s.episodes.length, 0)
  };
}

// --------------- Line weight calculation ---------------

function calculateSourceWeight(source, cachedStatus) {
  let weight = 100;
  if (cachedStatus) {
    if (cachedStatus.status === 'dead') weight = 0;
    else if (cachedStatus.status === 'slow') weight = 30;
    else if (cachedStatus.status === 'ok') weight = 100;
    if (cachedStatus.latency) {
      // Reduce weight for slow lines
      if (cachedStatus.latency > 3000) weight = Math.min(weight, 20);
      else if (cachedStatus.latency > 1000) weight = Math.min(weight, 60);
    }
  }
  return weight;
}

// --------------- Check source line health ---------------

async function checkSourceHealth(source, vodId) {
  if (!source.episodes || source.episodes.length === 0) {
    return { status: 'dead', latency: 0 };
  }

  // Check first episode URL validity
  const firstEp = source.episodes[0];
  const startTime = Date.now();
  const valid = await checkUrlValid(firstEp.play_url);
  const latency = Date.now() - startTime;

  const status = valid ? (latency > 3000 ? 'slow' : 'ok') : 'dead';

  // Cache the status
  const cacheKey = `line_status:${vodId}:${source.source_code}`;
  await cache.set(cacheKey, { status, latency, checked_at: Date.now() }, 600); // 10 min TTL

  return { status, latency };
}

// --------------- Batch health check all sources ---------------

async function checkAllSourcesHealth(vodId, sources) {
  const results = await Promise.allSettled(
    sources.map(s => checkSourceHealth(s, vodId))
  );

  return sources.map((source, i) => {
    const result = results[i];
    const health = result.status === 'fulfilled' ? result.value : { status: 'unknown', latency: 0 };

    return {
      ...source,
      weight: calculateSourceWeight(source, health),
      status: health.status === 'ok' ? 1 : health.status === 'slow' ? 2 : 0,
      latency: health.latency,
      // Sort episodes by status
      episodes: source.episodes.map(ep => ({
        ...ep,
        status: 1 // default active
      }))
    };
  }).sort((a, b) => b.weight - a.weight); // Sort by weight descending
}

// --------------- Filter active sources only ---------------

function filterActiveSources(sources) {
  return sources
    .filter(s => s.episodes && s.episodes.length > 0)
    .map(s => ({
      ...s,
      episodes: s.episodes.filter(ep => ep.play_url && ep.play_url.startsWith('http'))
    }))
    .filter(s => s.episodes.length > 0);
}

module.exports = {
  parseAppleCMS,
  buildVodObject,
  checkSourceHealth,
  checkAllSourcesHealth,
  filterActiveSources,
  detectType,
  calculateSourceWeight
};
