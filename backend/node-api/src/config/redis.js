'use strict';

const Redis  = require('ioredis');
const logger = require('../utils/logger');

let redis;

function initRedis() {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest:    3,
    enableReadyCheck:        true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    lazyConnect:             false,
  });

  redis.on('error',    (err) => logger.error('Redis error:', err));
  redis.on('connect',  ()    => logger.info('Redis connected'));
  redis.on('reconnecting', () => logger.warn('Redis reconnecting...'));

  return redis.ping();
}

// ─────────────────────────────────────────────
// TYPED CACHE HELPERS
// ─────────────────────────────────────────────

const TTL = {
  PRODUCT_CATALOG:    15 * 60,   // 15 min
  PLU_MAP:            15 * 60,
  VOLUME_RULES:       10 * 60,
  TIER_CONFIG:         5 * 60,
  AD_RATES:            5 * 60,
  TRUST_SCORE:        60 * 60,   // 1 hour
  GEO_DISCOVERY:       5 * 60,
  CUSTOMER_POINTS:     2 * 60,
  SESSION:            15 * 60,
  OTP:                 5 * 60,
  SUPERVISOR_PIN:         60,    // 60 seconds
};

const KEYS = {
  product:        (sid, pid) => `product:${sid}:${pid}`,
  pluMap:         (sid)      => `plu:${sid}`,
  volRules:       (sid)      => `vol_rules:${sid}`,
  tierConfig:     (tier)     => `tier_config:${tier}`,
  adRates:        (placement)=> `ad_rates:${placement}`,
  trustScore:     (sid)      => `trust:${sid}`,
  geoDiscover:    (lat, lng, mode) => `geo:${lat}:${lng}:${mode}`,
  pointsBal:      (cid, sid) => `points:${cid}:${sid}`,
  shiftState:     (shiftId)  => `shift:${shiftId}`,
  apiUsage:       (sid, api, win)  => `api_usage:${sid}:${api}:${win}`,
  adBudget:       (cid, date)=> `ad_budget:${cid}:${date}`,
  otp:            (mobile)   => `otp:${mobile}`,
  supervisorPin:  (userId)   => `sup_pin:${userId}`,
  rateLimit:      (key)      => `rl:${key}`,
  refreshToken:   (hash)     => `rt:${hash}`,
};

async function cacheGet(key) {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}

async function cacheSet(key, value, ttl) {
  return redis.set(key, JSON.stringify(value), 'EX', ttl);
}

async function cacheDel(...keys) {
  if (keys.length === 0) return 0;
  return redis.del(...keys);
}

async function cacheGetOrSet(key, ttl, fetchFn) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const fresh = await fetchFn();
  if (fresh !== null && fresh !== undefined) {
    await cacheSet(key, fresh, ttl);
  }
  return fresh;
}

// ─────────────────────────────────────────────
// RATE LIMITING HELPERS (sliding window)
// ─────────────────────────────────────────────

/**
 * Sliding window rate limiter.
 * Returns { allowed, remaining, resetAt }
 */
async function checkRateLimit(identifier, limit, windowSeconds) {
  const key = KEYS.rateLimit(identifier);
  const now = Date.now();
  const win = now - windowSeconds * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, '-inf', win);
  pipeline.zadd(key, now, `${now}`);
  pipeline.zcard(key);
  pipeline.expire(key, windowSeconds);

  const results = await pipeline.exec();
  const count   = results[2][1];
  const allowed = count <= limit;

  return {
    allowed,
    count,
    remaining: Math.max(0, limit - count),
    resetAt:   new Date(now + windowSeconds * 1000).toISOString(),
  };
}

// ─────────────────────────────────────────────
// AD BUDGET MANAGEMENT (atomic decrement)
// ─────────────────────────────────────────────

async function deductAdBudget(campaignId, amount) {
  const date = new Date().toISOString().split('T')[0];
  const key  = KEYS.adBudget(campaignId, date);
  const newVal = await redis.incrbyfloat(key, -amount);
  await redis.expire(key, 90_000); // 25 hours — covers end of day
  return parseFloat(newVal.toFixed(4));
}

async function getRemainingAdBudget(campaignId, dailyBudget) {
  const date = new Date().toISOString().split('T')[0];
  const key  = KEYS.adBudget(campaignId, date);
  const spent = await redis.get(key);
  return dailyBudget - Math.abs(parseFloat(spent || 0));
}

module.exports = {
  initRedis,
  get redis() { return redis; },
  TTL,
  KEYS,
  cacheGet,
  cacheSet,
  cacheDel,
  cacheGetOrSet,
  checkRateLimit,
  deductAdBudget,
  getRemainingAdBudget,
};
