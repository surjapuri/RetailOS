'use strict';

const rateLimit = require('express-rate-limit');
const { redis }  = require('../config/redis');
const AppError   = require('../utils/AppError');

const makeStore = () => ({
  async increment(key) {
    const res = await redis.multi()
      .incr(key).expire(key, 60).exec();
    return { totalHits: res[0][1] };
  },
  async decrement(key) { await redis.decr(key); },
  async resetKey(key)  { await redis.del(key); },
});

const makeLimit = (max, windowMs, msg) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
    store:           makeStore(),
    handler: (req, res) => res.status(429).json({ success: false, message: msg }),
    keyGenerator: (req) =>
      `rl:${req.ip}:${req.path}`,
  });

const rateLimiter = {
  api:        makeLimit(120, 60_000,  'Too many requests. Try again in a minute.'),
  auth:       makeLimit(10,  60_000,  'Too many auth attempts. Wait 60 seconds.'),
  otp:        makeLimit(3,   60_000,  'Too many OTP requests. Wait 60 seconds.'),
  payments:   makeLimit(30,  60_000,  'Too many payment requests.'),
  superAdmin: makeLimit(5,   60_000,  'Too many admin login attempts.'),
};

module.exports = { rateLimiter };
