// ============================================================
//  TMDB Metadata & Poster Service
//  Search → poster / backdrop → cache → fallback to vod_pic
// ============================================================

const axios = require('axios');
const cache = require('./cache');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
// TMDB_BASE_URL can be overridden to use a mirror or Cloudflare Worker proxy
// (needed in mainland China where api.themoviedb.org is blocked)
// e.g. TMDB_BASE_URL=https://tmdb-proxy.yourname.workers.dev
const TMDB_BASE = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

// TMDB_ENABLED=false disables all TMDB API calls (for GFW-blocked environments)
const TMDB_ENABLED = process.env.TMDB_ENABLED !== 'false';

// Circuit breaker: auto-disable TMDB after N consecutive failures
let consecutiveFails = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
let circuitOpen = false;

function recordFail() {
  consecutiveFails++;
  if (consecutiveFails >= CIRCUIT_BREAKER_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    console.error('[TMDB] Circuit breaker OPEN — TMDB disabled for this process lifetime. Restart server to retry.');
  }
}

function recordSuccess() {
  if (consecutiveFails > 0) consecutiveFails = 0;
}

function isAvailable() {
  if (!TMDB_ENABLED) return false;
  if (circuitOpen) return false;
  if (!TMDB_API_KEY) return false;
  return true;
}

// Available poster sizes
const POSTER_SIZES = {
  w300: 'w300',
  w500: 'w500',
  w780: 'w780',
  original: 'original'
};

const BACKDROP_SIZES = {
  w780: 'w780',
  w1280: 'w1280',
  original: 'original'
};

const tmdbClient = axios.create({
  baseURL: TMDB_BASE,
  timeout: 3000,
  params: { api_key: TMDB_API_KEY, language: 'zh-CN' }
});

// --------------- Search movie by name ---------------
async function searchMovie(name, year) {
  if (!isAvailable()) return null;

  try {
    const params = { query: name };
    if (year) params.year = year;

    const { data } = await tmdbClient.get('/search/movie', { params });

    if (data.results && data.results.length > 0) {
      recordSuccess();
      return data.results[0]; // Best match
    }
    recordSuccess();
    return null;
  } catch (err) {
    recordFail();
    console.error('[TMDB] Search error:', err.message);
    return null;
  }
}

// --------------- Search TV show by name ---------------
async function searchTV(name) {
  if (!isAvailable()) return null;

  try {
    const { data } = await tmdbClient.get('/search/tv', {
      params: { query: name }
    });

    if (data.results && data.results.length > 0) {
      recordSuccess();
      return data.results[0];
    }
    recordSuccess();
    return null;
  } catch (err) {
    recordFail();
    console.error('[TMDB] TV search error:', err.message);
    return null;
  }
}

// --------------- Get movie details with full metadata ---------------
async function getMovieDetail(tmdbId) {
  if (!isAvailable()) return null;

  try {
    const { data } = await tmdbClient.get(`/movie/${tmdbId}`);
    recordSuccess();
    return data;
  } catch (err) {
    recordFail();
    console.error('[TMDB] Movie detail error:', err.message);
    return null;
  }
}

// --------------- Get TV details ---------------
async function getTVDetail(tmdbId) {
  if (!isAvailable()) return null;

  try {
    const { data } = await tmdbClient.get(`/tv/${tmdbId}`);
    recordSuccess();
    return data;
  } catch (err) {
    recordFail();
    console.error('[TMDB] TV detail error:', err.message);
    return null;
  }
}

// --------------- Build poster URL from path ---------------
function posterUrl(path, size = 'w500') {
  if (!path) return '';
  const sizeKey = POSTER_SIZES[size] || 'w500';
  const directUrl = `${TMDB_IMAGE_BASE}/${sizeKey}${path}`;
  return `/api/tmdb/image-proxy?url=${encodeURIComponent(directUrl)}`;
}

function backdropUrl(path, size = 'w1280') {
  if (!path) return '';
  const sizeKey = BACKDROP_SIZES[size] || 'w1280';
  const directUrl = `${TMDB_IMAGE_BASE}/${sizeKey}${path}`;
  return `/api/tmdb/image-proxy?url=${encodeURIComponent(directUrl)}`;
}

// --------------- Enrich a VOD record with TMDB metadata ---------------
async function enrichVod(vod) {
  if (!isAvailable() || !vod) return vod;

  const cacheKey = `tmdb:${vod.vod_id || vod.id}`;
  const cached = await cache.get(cacheKey);
  if (cached) return { ...vod, ...cached };

  const name = vod.vod_name || vod.title || '';
  const year = vod.vod_year || vod.year || '';

  try {
    // Try movie search first, then TV
    let result = await searchMovie(name, year);
    let mediaType = 'movie';

    if (!result) {
      result = await searchTV(name);
      mediaType = 'tv';
    }

    if (result) {
      const enrichment = {
        tmdb_id: String(result.id),
        poster: posterUrl(result.poster_path, 'w500') || vod.vod_pic || vod.poster || '',
        backdrop: backdropUrl(result.backdrop_path) || '',
        poster_w300: posterUrl(result.poster_path, 'w300'),
        poster_w780: posterUrl(result.poster_path, 'w780'),
        poster_original: posterUrl(result.poster_path, 'original'),
        tmdb_rating: result.vote_average || '',
        tmdb_overview: result.overview || '',
        tmdb_media_type: mediaType,
        tmdb_title: result.title || result.name || ''
      };

      // Cache for 24 hours
      await cache.set(cacheKey, enrichment, 86400);

      // Update DB in background
      updateVodTMDB(vod.vod_id || vod.id, enrichment);

      return { ...vod, ...enrichment };
    }
  } catch (err) {
    recordFail();
    console.error('[TMDB] Enrich error:', err.message);
  }

  // No TMDB match — cache null briefly to avoid repeated searches
  await cache.set(cacheKey, { poster: vod.vod_pic || vod.poster || '' }, 3600);
  return vod;
}

// --------------- Batch enrich multiple VODs ---------------
async function enrichVods(vods) {
  if (!isAvailable() || !vods || vods.length === 0) return vods;

  const results = await Promise.allSettled(
    vods.map(v => enrichVod(v))
  );

  return vods.map((vod, i) => {
    const r = results[i];
    return r.status === 'fulfilled' ? r.value : vod;
  });
}

// --------------- Update MySQL with TMDB data ---------------
async function updateVodTMDB(vodId, tmdbData) {
  if (!vodId || !tmdbData.tmdb_id) return;

  try {
    const pool = require('../db');
    await pool.query(
      `UPDATE vods SET tmdb_id = ?, poster = ?, backdrop = ? WHERE vod_id = ?`,
      [tmdbData.tmdb_id, tmdbData.poster, tmdbData.backdrop, vodId]
    );
  } catch (err) {
    // Non-critical — DB might not be available yet
  }
}

// --------------- Full metadata lookup (for admin auto-fill) ---------------
async function searchMovieFull(title, year) {
  if (!isAvailable() || !title) return null;

  try {
    // Search movie
    const searchParams = { query: title, language: 'zh-CN' };
    if (year) searchParams.year = String(year).substring(0, 4);

    const { data: searchData } = await tmdbClient.get('/search/movie', { params: searchParams });
    if (!searchData.results || searchData.results.length === 0) {
      // Try TV search
      return await searchTVFull(title, year);
    }

    // Pick best match
    let movie = searchData.results[0];
    const titleLower = title.toLowerCase();
    const exactMatch = searchData.results.find(m =>
      (m.title || '').toLowerCase() === titleLower ||
      (m.original_title || '').toLowerCase() === titleLower
    );
    if (exactMatch) movie = exactMatch;

    // Get detail with credits for director/actors
    const detailParams = { language: 'zh-CN', append_to_response: 'credits,external_ids' };
    const { data: detail } = await tmdbClient.get(`/movie/${movie.id}`, { params: detailParams });

    const director = detail.credits && detail.credits.crew
      ? detail.credits.crew.filter(c => c.job === 'Director').map(c => c.name).join(', ')
      : '';
    const actors = detail.credits && detail.credits.cast
      ? detail.credits.cast.slice(0, 5).map(c => c.name).join(', ')
      : '';
    const imdbId = (detail.external_ids && detail.external_ids.imdb_id) || detail.imdb_id || '';

    const wp = (path, size) => posterUrl(path, size);
    const wb = (path, size) => backdropUrl(path, size);
    const posterSizes = {
      w185: movie.poster_path ? wp(movie.poster_path, 'w300') : '',
      w342: movie.poster_path ? wp(movie.poster_path, 'w500') : '',
      w500: movie.poster_path ? wp(movie.poster_path, 'w500') : '',
      original: movie.poster_path ? wp(movie.poster_path, 'original') : ''
    };
    const backdropSizes = {
      w780: movie.backdrop_path ? wb(movie.backdrop_path, 'w780') : '',
      w1280: movie.backdrop_path ? wb(movie.backdrop_path, 'w1280') : '',
      original: movie.backdrop_path ? wb(movie.backdrop_path, 'original') : ''
    };

    return {
      title: detail.title || movie.title || '',
      year: (detail.release_date || movie.release_date || '').substring(0, 4),
      release_date: detail.release_date || movie.release_date || '',
      poster: posterSizes.w500,
      poster_w185: posterSizes.w185,
      poster_w342: posterSizes.w342,
      poster_original: posterSizes.original,
      backdrop: backdropSizes.w780,
      backdrop_w1280: backdropSizes.w1280,
      backdrop_original: backdropSizes.original,
      rating: detail.vote_average ? String(detail.vote_average) : '',
      genre: (detail.genres || []).map(g => g.name).join(' / '),
      description: detail.overview || movie.overview || '',
      director,
      actors,
      duration: detail.runtime ? String(detail.runtime) + ' min' : '',
      tmdb_id: String(movie.id),
      imdb_id: imdbId,
      source: 'tmdb'
    };
  } catch (err) {
    recordFail();
    console.error('[TMDB] Full search error:', err.message);
    return null;
  }
}

async function searchTVFull(title, year) {
  if (!isAvailable() || !title) return null;

  try {
    const searchParams = { query: title, language: 'zh-CN' };
    if (year) searchParams.first_air_date_year = String(year).substring(0, 4);

    const { data: searchData } = await tmdbClient.get('/search/tv', { params: searchParams });
    if (!searchData.results || searchData.results.length === 0) return null;

    const show = searchData.results[0];
    const detailParams = { language: 'zh-CN', append_to_response: 'credits,external_ids' };
    const { data: detail } = await tmdbClient.get(`/tv/${show.id}`, { params: detailParams });

    const creators = detail.created_by ? detail.created_by.map(c => c.name).join(', ') : '';
    const actors = detail.credits && detail.credits.cast
      ? detail.credits.cast.slice(0, 5).map(c => c.name).join(', ')
      : '';
    const imdbId = (detail.external_ids && detail.external_ids.imdb_id) || '';

    const wp = (path, size) => posterUrl(path, size);
    const wb = (path, size) => backdropUrl(path, size);
    const posterSizes = {
      w185: show.poster_path ? wp(show.poster_path, 'w300') : '',
      w342: show.poster_path ? wp(show.poster_path, 'w500') : '',
      w500: show.poster_path ? wp(show.poster_path, 'w500') : '',
      original: show.poster_path ? wp(show.poster_path, 'original') : ''
    };
    const backdropSizes = {
      w780: show.backdrop_path ? wb(show.backdrop_path, 'w780') : '',
      w1280: show.backdrop_path ? wb(show.backdrop_path, 'w1280') : '',
      original: show.backdrop_path ? wb(show.backdrop_path, 'original') : ''
    };

    return {
      title: detail.name || show.name || '',
      year: (detail.first_air_date || show.first_air_date || '').substring(0, 4),
      release_date: detail.first_air_date || show.first_air_date || '',
      poster: posterSizes.w500,
      poster_w185: posterSizes.w185,
      poster_w342: posterSizes.w342,
      poster_original: posterSizes.original,
      backdrop: backdropSizes.w780,
      backdrop_w1280: backdropSizes.w1280,
      backdrop_original: backdropSizes.original,
      rating: detail.vote_average ? String(detail.vote_average) : '',
      genre: (detail.genres || []).map(g => g.name).join(' / '),
      description: detail.overview || show.overview || '',
      director: creators,
      actors,
      duration: detail.number_of_seasons ? String(detail.number_of_seasons) + ' seasons' : '',
      tmdb_id: String(show.id),
      imdb_id: imdbId,
      source: 'tmdb'
    };
  } catch (err) {
    recordFail();
    console.error('[TMDB] TV full search error:', err.message);
    return null;
  }
}

// --------------- Check if TMDB is configured ---------------
function isConfigured() {
  return isAvailable();
}

module.exports = {
  searchMovie,
  searchTV,
  getMovieDetail,
  getTVDetail,
  searchMovieFull,
  searchTVFull,
  posterUrl,
  backdropUrl,
  enrichVod,
  enrichVods,
  isConfigured,
  isAvailable,
  TMDB_IMAGE_BASE
};
