// Title normalization for dedup: strip year, language, and version suffixes
function normalizeTitle(title) {
  if (!title) return '';
  return title
    // Parenthesized suffixes: (2026), （2026）, (粤语), （国语）, (中英双语), (又名xxx), etc.
    .replace(/[\s]*[\(（][^)）]*[\)）]/g, '')
    // Concatenated language suffixes at end
    .replace(/(?:粤语版|国语版|英语版|日语版|韩语版|英文版|中文版|粤语|国语|英语|日语|韩语|中字|双语|英文|中文|普通话|四川话|版本|配音|原版|修复版|先行版|预告片)$/g, '')
    // Space-separated language/version suffixes at end
    .replace(/[\s]+(?:粤语版|国语版|英语版|日语版|韩语版|英文版|中文版|粤语|国语|英语|日语|韩语|中字|双语|英文|中文|普通话|四川话|版本|配音|原版|修复版|先行版|预告片|终极版)[\s]*$/gi, '')
    // Concatenated year suffix (e.g. "雨霖铃2026")
    .replace(/\d{4}$/g, '')
    // Trailing year after space
    .replace(/[\s]+\d{4}[\s]*$/g, '')
    // Collapse whitespace
    .replace(/[\s]+/g, '')
    .toLowerCase();
}

// Dedup VOD rows by normalized title, keeping the best variant
function dedupVods(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeTitle(row.vod_name || row.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const result = [];
  for (const [, group] of groups) {
    group.sort((a, b) => {
      const scoreA = (a.poster || a.vod_pic ? 4 : 0) + (a.vod_year ? 2 : 0)
        + (parseFloat(a.douban_rating || a.vod_score) > 0 ? 2 : 0)
        + (a.vod_lang ? 1 : 0) + ((a.vod_hits || 0) > 0 ? 1 : 0);
      const scoreB = (b.poster || b.vod_pic ? 4 : 0) + (b.vod_year ? 2 : 0)
        + (parseFloat(b.douban_rating || b.vod_score) > 0 ? 2 : 0)
        + (b.vod_lang ? 1 : 0) + ((b.vod_hits || 0) > 0 ? 1 : 0);
      return scoreB - scoreA;
    });

    const best = group[0];
    best._variants = group.map(r => ({
      vod_id: r.vod_id || r.id,
      title: r.vod_name || r.title,
      year: r.vod_year,
      lang: r.vod_lang,
      poster: r.poster || r.vod_pic || r.poster_url
    }));
    result.push(best);
  }
  return result;
}

module.exports = { normalizeTitle, dedupVods };
