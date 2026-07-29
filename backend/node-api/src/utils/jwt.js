'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../config/database');
const { redis, KEYS, TTL } = require('../config/redis');

const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';
const ADMIN_TTL   = '30m';

// ─────────────────────────────────────────────
// TOKEN GENERATION
// ─────────────────────────────────────────────

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn:  ACCESS_TTL,
    algorithm:  'HS256',
    issuer:     'retailos-api',
    audience:   'retailos-app',
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn:  REFRESH_TTL,
    algorithm:  'HS256',
    issuer:     'retailos-api',
    audience:   'retailos-app',
  });
}

function signSuperAdminToken(payload) {
  return jwt.sign(payload, process.env.JWT_SUPER_ADMIN_SECRET, {
    expiresIn:  ADMIN_TTL,
    algorithm:  'HS256',
    issuer:     'retailos-superadmin',
    audience:   'retailos-superadmin',
  });
}

// ─────────────────────────────────────────────
// TOKEN VERIFICATION
// ─────────────────────────────────────────────

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
    issuer:   'retailos-api',
    audience: 'retailos-app',
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
    issuer:   'retailos-api',
    audience: 'retailos-app',
  });
}

function verifySuperAdminToken(token) {
  return jwt.verify(token, process.env.JWT_SUPER_ADMIN_SECRET, {
    issuer:   'retailos-superadmin',
    audience: 'retailos-superadmin',
  });
}

// ─────────────────────────────────────────────
// REFRESH TOKEN MANAGEMENT (stored server-side)
// ─────────────────────────────────────────────

async function storeRefreshToken(userId, token, deviceId) {
  const hash    = crypto.createHash('sha256').update(token).digest('hex');
  const expiry  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_id, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, hash, deviceId || null, expiry]
  );
}

async function verifyAndRotateRefreshToken(token) {
  const hash   = crypto.createHash('sha256').update(token).digest('hex');
  const result = await db.query(
    `SELECT id, user_id, expires_at, revoked, device_id
     FROM refresh_tokens
     WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) throw new Error('INVALID_REFRESH_TOKEN');
  const rt = result.rows[0];

  if (rt.revoked)              throw new Error('TOKEN_REVOKED');
  if (new Date(rt.expires_at) < new Date()) throw new Error('TOKEN_EXPIRED');

  // Rotate: revoke old, we'll issue new after
  await db.query(
    `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1`,
    [rt.id]
  );

  return { userId: rt.user_id, deviceId: rt.device_id };
}

async function revokeAllUserTokens(userId) {
  await db.query(
    `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW()
     WHERE user_id = $1 AND revoked = FALSE`,
    [userId]
  );
}

// ─────────────────────────────────────────────
// FULL AUTH TOKEN PAIR CREATION
// ─────────────────────────────────────────────

async function createTokenPair(user, deviceId) {
  const payload = {
    sub:        user.id,
    storeId:    user.store_id,
    branchId:   user.branch_id || null,
    role:       user.role,
    roleLevel:  user.role_level,
    name:       user.name,
  };

  const accessToken  = signAccessToken(payload);
  const refreshToken = signRefreshToken({ sub: user.id });

  await storeRefreshToken(user.id, refreshToken, deviceId);

  return {
    accessToken,
    refreshToken,
    expiresIn: 15 * 60, // seconds
    tokenType: 'Bearer',
  };
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  signSuperAdminToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifySuperAdminToken,
  storeRefreshToken,
  verifyAndRotateRefreshToken,
  revokeAllUserTokens,
  createTokenPair,
};
