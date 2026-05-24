// Auto-detect series groupings from video titles
// Strips season/part suffixes to find common base titles, then groups them.

const SEASON_PATTERNS = [
  // Chinese season patterns (order matters: specific before general)
  { regex: /^(.+?)\s*第\s*([一二三四五六七八九十百千\d]+)\s*季\s*$/i, label: (m) => `第${m[2]}季` },
  { regex: /^(.+?)\s*第\s*([一二三四五六七八九十百千\d]+)\s*部\s*$/i, label: (m) => `第${m[2]}部` },
  { regex: /^(.+?)\s*第\s*([一二三四五六七八九十百千\d]+)\s*期\s*$/i, label: (m) => `第${m[2]}期` },
  // English season patterns
  { regex: /^(.+?)\s*Season\s*(\d+)\s*$/i, label: (m) => `Season ${m[2]}` },
  // Special types
  { regex: /^(.+?)\s*(剧场版|電影版|OVA|OAD|特别篇|SP|番外篇|外传)\s*$/i, label: (m) => m[2] },
  // Year suffix (with or without parens)
  { regex: /^(.+?)\s*[\(（]\s*(\d{4})\s*[\)）]\s*$/i, label: (m) => m[2] },
  // Part X / 上中下
  { regex: /^(.+?)\s*Part\s*(\d+)\s*$/i, label: (m) => `Part ${m[2]}` },
  { regex: /^(.+?)\s*([上下中])\s*$/i, label: (m) => m[2] },
];

function chineseToNumber(s) {
  const map = { '一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10','百':'100','千':'1000' };
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // Only handles simple cases like 十二 (= 12)
  if (s === '十') return 10;
  let val = 0;
  for (const ch of s) {
    if (!map[ch]) return null;
    const n = parseInt(map[ch]);
    if (n >= 10) { val = val === 0 ? n : val * n; }
    else { val += n; }
  }
  return val;
}

/**
 * Detect series grouping for a list of {title} objects.
 * Returns an array of { seriesTitle, seasonLabel, originalTitle } assignments.
 */
function detectSeriesGroups(videos) {
  const results = [];

  for (const v of videos) {
    const title = (v.title || '').trim();
    if (!title) continue;

    let matched = false;
    for (const pat of SEASON_PATTERNS) {
      const m = title.match(pat.regex);
      if (m) {
        const seriesTitle = m[1].trim();
        const seasonLabel = typeof pat.label === 'function' ? pat.label(m) : pat.label;
        results.push({
          id: v.id,
          originalTitle: title,
          seriesTitle,
          seasonLabel,
        });
        matched = true;
        break;
      }
    }
    // If no pattern matched, still consider as standalone (seriesTitle = title)
    if (!matched) {
      results.push({
        id: v.id,
        originalTitle: title,
        seriesTitle: title, // standalone — no grouping
        seasonLabel: '',
      });
    }
  }

  return results;
}

/**
 * Build series groups: cluster videos by seriesTitle, assign season sort order.
 * Only groups that have ≥2 videos sharing the same seriesTitle are real series.
 */
function buildSeriesGroups(assignments) {
  const groups = new Map();

  for (const a of assignments) {
    const key = a.seriesTitle.toLowerCase().replace(/\s+/g, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const series = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue; // need ≥2 to be a series

    // Pick canonical series title (longest common, or most frequent)
    const canonicalTitle = members[0].seriesTitle;

    // Sort seasons: numeric first, then text labels alphabetically
    const sorted = [...members].sort((a, b) => {
      const na = chineseToNumber(a.seasonLabel.replace(/[^一二三四五六七八九十百千\d]/g, ''));
      const nb = chineseToNumber(b.seasonLabel.replace(/[^一二三四五六七八九十百千\d]/g, ''));
      if (na !== null && nb !== null) return na - nb;
      if (na !== null) return -1; // numeric before text
      if (nb !== null) return 1;
      return a.seasonLabel.localeCompare(b.seasonLabel);
    });

    series.push({
      seriesTitle: canonicalTitle,
      members: sorted,
    });
  }

  return series;
}

/**
 * One-shot: given a list of video objects, return ready-to-apply series groups.
 */
function analyzeSeries(videos) {
  const assignments = detectSeriesGroups(videos);
  const series = buildSeriesGroups(assignments);

  // Build flat apply list for all videos in series groups
  const applyList = [];
  for (const s of series) {
    for (const m of s.members) {
      applyList.push({
        id: m.id,
        series_title: s.seriesTitle,
        season_label: m.seasonLabel,
      });
    }
  }

  return { series, applyList };
}

module.exports = { detectSeriesGroups, buildSeriesGroups, analyzeSeries, chineseToNumber };
