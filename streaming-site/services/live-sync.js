const axios = require('axios');
const cron = require('node-cron');
const db = require('../database');

const DEFAULT_LIVE_M3U_URL = process.env.LIVE_M3U_URL || 'https://raw.githubusercontent.com/mursor1985/LIVE/refs/heads/main/yylunbo.m3u';
const LIVE_CATEGORY = 'liveChannels';
const LIVE_BADGE = 'LIVE_SYNC';
const LIVE_LOG_SOURCE = 'mursor1985/LIVE';

let isSyncing = false;

function cleanText(value) {
  return String(value || '').replace(/\u0000/g, '').trim();
}

function pickAttr(extinfLine, attrName) {
  const regex = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const match = regex.exec(extinfLine);
  return cleanText(match ? match[1] : '');
}

function parseExtinf(extinfLine) {
  const line = cleanText(extinfLine);
  const commaIndex = line.indexOf(',');
  const displayName = commaIndex >= 0 ? cleanText(line.slice(commaIndex + 1)) : '';
  const tvgName = pickAttr(line, 'tvg-name');

  return {
    name: displayName || tvgName || 'Unnamed Channel',
    group: pickAttr(line, 'group-title') || 'Ungrouped',
    logo: pickAttr(line, 'tvg-logo')
  };
}

function parseM3U(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  const channels = [];
  const seen = new Set();
  let pending = null;

  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      pending = parseExtinf(line);
      continue;
    }

    if (line.startsWith('#')) continue;
    if (!pending) continue;

    const streamUrl = line;
    if (!/^https?:\/\//i.test(streamUrl)) {
      pending = null;
      continue;
    }

    const key = `${pending.name}||${streamUrl}`;
    if (seen.has(key)) {
      pending = null;
      continue;
    }
    seen.add(key);

    channels.push({
      name: pending.name,
      group: pending.group || 'Ungrouped',
      logo: pending.logo || '',
      url: streamUrl
    });

    pending = null;
  }

  return channels;
}

function syncChannelsToDB(channels, sourceUrl = DEFAULT_LIVE_M3U_URL) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const existing = db
    .prepare('SELECT id, title, video_url FROM videos WHERE category = ? AND badge = ?')
    .all(LIVE_CATEGORY, LIVE_BADGE);

  const existingByKey = new Map(
    existing.map(row => [`${cleanText(row.title)}||${cleanText(row.video_url)}`, row])
  );

  const touchedIds = new Set();
  let inserted = 0;
  let updated = 0;

  const insertStmt = db.prepare(`
    INSERT INTO videos
    (title, category, description, poster_url, backdrop_url, video_url, year, duration, genre, rating, badge, is_live, featured, sort_order, series_title, season_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = db.prepare(`
    UPDATE videos
    SET title = ?, description = ?, poster_url = ?, video_url = ?, genre = ?, is_live = 1, featured = 0, sort_order = ?
    WHERE id = ?
  `);

  const deleteStmt = db.prepare('DELETE FROM videos WHERE id = ?');

  const tx = db.transaction((rows) => {
    rows.forEach((channel, index) => {
      const key = `${cleanText(channel.name)}||${cleanText(channel.url)}`;
      const description = `Live group: ${channel.group}`;
      const existingRow = existingByKey.get(key);

      if (existingRow) {
        updateStmt.run(
          channel.name,
          description,
          channel.logo || '',
          channel.url,
          channel.group || '',
          index,
          existingRow.id
        );
        touchedIds.add(existingRow.id);
        updated++;
      } else {
        const result = insertStmt.run(
          channel.name,
          LIVE_CATEGORY,
          description,
          channel.logo || '',
          '',
          channel.url,
          '',
          '',
          channel.group || '',
          0,
          LIVE_BADGE,
          1,
          0,
          index,
          '',
          ''
        );
        touchedIds.add(result.lastInsertRowid);
        inserted++;
      }
    });

    let deleted = 0;
    for (const row of existing) {
      if (!touchedIds.has(row.id)) {
        deleteStmt.run(row.id);
        deleted++;
      }
    }

    return deleted;
  });

  const deleted = tx(channels);

  db.prepare(`
    INSERT INTO collect_logs (source_name, collect_type, total_fetched, new_added, updated_existing, status, duration_ms, error_msg)
    VALUES (?, 'live_m3u', ?, ?, ?, 'success', 0, ?)
  `).run(LIVE_LOG_SOURCE, channels.length, inserted, updated, `url=${sourceUrl}; at=${now}; deleted=${deleted}`);

  return { inserted, updated, deleted, total: channels.length };
}

async function syncLiveChannels(options = {}) {
  const sourceUrl = cleanText(options.url || DEFAULT_LIVE_M3U_URL);
  if (!sourceUrl) return { success: false, error: 'Missing live source URL' };
  if (isSyncing) return { success: false, status: 'already_running', error: 'Live sync task is already running.' };

  isSyncing = true;
  const start = Date.now();

  try {
    const response = await axios.get(sourceUrl, {
      timeout: 30000,
      responseType: 'text',
      transformResponse: [(data) => data]
    });

    const channels = parseM3U(response.data || '');
    if (channels.length === 0) {
      throw new Error('No playable channels parsed from M3U');
    }

    const summary = syncChannelsToDB(channels, sourceUrl);

    const duration = Date.now() - start;
    db.prepare(`
      UPDATE collect_logs
      SET duration_ms = ?
      WHERE id = (
        SELECT id FROM collect_logs
        WHERE collect_type = 'live_m3u' AND status = 'success'
        ORDER BY id DESC LIMIT 1
      )
    `).run(duration);

    return {
      success: true,
      source_url: sourceUrl,
      duration_ms: duration,
      ...summary
    };
  } catch (err) {
    const duration = Date.now() - start;
    try {
      db.prepare(`
        INSERT INTO collect_logs (source_name, collect_type, total_fetched, new_added, updated_existing, status, duration_ms, error_msg)
        VALUES (?, 'live_m3u', 0, 0, 0, 'failed', ?, ?)
      `).run(LIVE_LOG_SOURCE, duration, String(err.message || err));
    } catch {}

    return { success: false, error: err.message || String(err), duration_ms: duration };
  } finally {
    isSyncing = false;
  }
}

function startLiveSyncScheduler() {
  // Every 2 hours at minute 17.
  cron.schedule('17 */2 * * *', async () => {
    const result = await syncLiveChannels();
    if (!result.success) {
      console.error('[LiveSync] Scheduled sync failed:', result.error || 'unknown error');
    } else {
      console.log(`[LiveSync] Scheduled sync done: total=${result.total}, inserted=${result.inserted}, updated=${result.updated}, deleted=${result.deleted}`);
    }
  });

  // Initial boot sync.
  setTimeout(async () => {
    const result = await syncLiveChannels();
    if (!result.success) {
      console.error('[LiveSync] Initial sync failed:', result.error || 'unknown error');
    } else {
      console.log(`[LiveSync] Initial sync done: total=${result.total}, inserted=${result.inserted}, updated=${result.updated}, deleted=${result.deleted}`);
    }
  }, 10000);
}

module.exports = {
  DEFAULT_LIVE_M3U_URL,
  LIVE_CATEGORY,
  LIVE_BADGE,
  syncLiveChannels,
  startLiveSyncScheduler
};
