// ============================================================
//  Redis Cache Layer — with in-memory fallback for dev
//  TTL, anti-penetration (null cache), anti-avalanche (jitter)
// ============================================================

let Redis;
let redis = null;

// Try to connect to Redis, fall back to in-memory cache
async function initRedis() {
  try {
    Redis = require('ioredis');
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || '',
      db: process.env.REDIS_DB || 0,
      retryStrategy: (times) => {
        if (times > 2) return null;
        return Math.min(times * 300, 2000);
      },
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false
    });

    // Suppress connection errors during dev
    redis.on('error', () => {});

    await redis.connect();
    console.log('[Cache] Redis connected');
    return true;
  } catch (err) {
    console.log('[Cache] Redis unavailable — using in-memory cache (dev mode)');
    redis = null;
    return false;
  }
}

// --------------- In-memory fallback cache ---------------
const memCache = new Map();
const memTimers = new Map();

// --------------- Public API (transparent Redis/memory switch) ---------------

const CACHE_PREFIX = 'syn:';

// Get from cache
async function get(key) {
  const fullKey = CACHE_PREFIX + key;
  if (redis) {
    try {
      const val = await redis.get(fullKey);
      if (val === '@@NULL@@') return null; // anti-penetration null marker
      return val ? JSON.parse(val) : null;
    } catch { /* fall through to null */ }
  }

  // In-memory fallback
  const entry = memCache.get(fullKey);
  if (!entry) return undefined;
  if (entry.expiry && Date.now() > entry.expiry) {
    memCache.delete(fullKey);
    memTimers.delete(fullKey);
    return undefined;
  }
  return entry.value;
}

// Set cache with TTL (seconds)
async function set(key, value, ttlSeconds = 3600) {
  const fullKey = CACHE_PREFIX + key;
  const jitter = Math.floor(Math.random() * (ttlSeconds * 0.1)); // 10% jitter anti-avalanche
  const ttl = ttlSeconds + jitter;

  if (redis) {
    try {
      const serialized = JSON.stringify(value);
      await redis.setex(fullKey, ttl, serialized);
      return;
    } catch { /* fall through */ }
  }

  // In-memory fallback
  memCache.set(fullKey, { value, expiry: Date.now() + ttl * 1000 });

  if (memTimers.has(fullKey)) clearTimeout(memTimers.get(fullKey));
  memTimers.set(fullKey, setTimeout(() => {
    memCache.delete(fullKey);
    memTimers.delete(fullKey);
  }, ttl * 1000));
}

// Cache null marker (anti-penetration: short TTL for empty results)
async function setNull(key, ttlSeconds = 60) {
  const fullKey = CACHE_PREFIX + key;
  if (redis) {
    try {
      await redis.setex(fullKey, ttlSeconds, '@@NULL@@');
      return;
    } catch { /* fall through */ }
  }
  memCache.set(fullKey, { value: null, expiry: Date.now() + ttlSeconds * 1000 });
}

// Delete cache entry
async function del(key) {
  const fullKey = CACHE_PREFIX + key;
  if (redis) {
    try { await redis.del(fullKey); } catch { /* */ }
  }
  memCache.delete(fullKey);
  if (memTimers.has(fullKey)) {
    clearTimeout(memTimers.get(fullKey));
    memTimers.delete(fullKey);
  }
}

// Delete by pattern (Redis only — memory fallback uses prefix scan)
async function delPattern(pattern) {
  const fullPattern = CACHE_PREFIX + pattern;
  if (redis) {
    try {
      const keys = await redis.keys(fullPattern);
      if (keys.length > 0) await redis.del(keys);
    } catch { /* */ }
  }
  // Memory fallback: delete keys starting with pattern
  const prefix = fullPattern.replace(/\*/g, '');
  for (const [k] of memCache) {
    if (k.startsWith(prefix)) {
      memCache.delete(k);
      if (memTimers.has(k)) { clearTimeout(memTimers.get(k)); memTimers.delete(k); }
    }
  }
}

// Increment counter (for hot keywords ranking)
async function zincrby(key, member, increment = 1) {
  if (redis) {
    try { return await redis.zincrby(CACHE_PREFIX + key, increment, member); } catch { /* */ }
  }
  // Simple fallback
  const fullKey = CACHE_PREFIX + key + ':' + member;
  const current = (await get(fullKey)) || 0;
  await set(fullKey, current + increment, 86400);
  return current + increment;
}

// Get top N from sorted set (for hot keywords)
async function zrevrange(key, start, stop) {
  if (redis) {
    try { return await redis.zrevrange(CACHE_PREFIX + key, start, stop, 'WITHSCORES'); } catch { return []; }
  }
  return [];
}

// Check if Redis is connected
function isConnected() {
  return redis !== null && redis.status === 'ready';
}

module.exports = { initRedis, get, set, setNull, del, delPattern, zincrby, zrevrange, isConnected };
