'use strict';

const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const { totp } = require('otplib');
const { db }   = require('../../config/database');
const { redis, KEYS, TTL, cacheSet, cacheGet, cacheDel } = require('../../config/redis');
const { createTokenPair, verifyAndRotateRefreshToken,
        revokeAllUserTokens, signSuperAdminToken } = require('../../utils/jwt');
const AppError = require('../../utils/AppError');
const { sendFCM } = require('../../utils/fcm');
const logger   = require('../../utils/logger');

const BCRYPT_ROUNDS  = 12;
const OTP_EXPIRY_SEC = 5 * 60;        // 5 minutes
const OTP_COOLDOWN   = 60;            // 1 min between resends

// ─────────────────────────────────────────────
// OTP SEND (uses Redis, no DB writes needed)
// ─────────────────────────────────────────────

async function sendOTP(mobile) {
  // Cooldown check
  const coolKey = `otp_cd:${mobile}`;
  if (await redis.get(coolKey)) {
    throw new AppError('Please wait 60 seconds before requesting another OTP', 429);
  }

  const otp    = Math.floor(100000 + Math.random() * 900000).toString();
  const hash   = await bcrypt.hash(otp, 8);           // lightweight hash for OTP

  await redis.set(KEYS.otp(mobile), hash, 'EX', OTP_EXPIRY_SEC);
  await redis.set(coolKey, '1', 'EX', OTP_COOLDOWN);

  // In production, send via SMS gateway (MSG91, Twilio, etc.)
  // For now, log in dev mode
  if (process.env.NODE_ENV !== 'production') {
    logger.info(`DEV OTP for ${mobile}: ${otp}`);
  } else {
    await sendSMS(mobile, `Your RetailOS OTP is ${otp}. Valid for 5 minutes. DO NOT share.`);
  }

  return { message: 'OTP sent successfully' };
}

async function verifyOTP(mobile, otp) {
  const hash = await redis.get(KEYS.otp(mobile));
  if (!hash) throw new AppError('OTP expired or not found. Please request a new one.', 400);

  const valid = await bcrypt.compare(otp, hash);
  if (!valid)  throw new AppError('Invalid OTP', 400);

  await redis.del(KEYS.otp(mobile)); // consumed — one-time use
  return true;
}

// ─────────────────────────────────────────────
// STORE ONBOARDING
// ─────────────────────────────────────────────

async function registerStore({ businessName, ownerMobile, otp, deviceId }) {
  await verifyOTP(ownerMobile, otp);

  return db.transaction(async (client) => {
    // Check if mobile already registered
    const existing = await client.query(
      `SELECT id FROM stores WHERE owner_mobile = $1`, [ownerMobile]
    );
    if (existing.rows.length > 0) {
      throw new AppError('Mobile number already registered', 409);
    }

    // Create store
    const storeResult = await client.query(
      `INSERT INTO stores (business_name, owner_mobile)
       VALUES ($1, $2) RETURNING id, subscription_tier, kyb_status`,
      [businessName, ownerMobile]
    );
    const store = storeResult.rows[0];

    // Create default admin user
    const userResult = await client.query(
      `INSERT INTO users (store_id, name, mobile, role, role_level)
       VALUES ($1, $2, $3, 'admin', 5)
       RETURNING id, store_id, branch_id, role, role_level, name`,
      [store.id, businessName + ' Admin', ownerMobile]
    );
    const user = userResult.rows[0];

    // Create default branch
    await client.query(
      `INSERT INTO branches (store_id, name, address)
       VALUES ($1, $2, 'Main Branch')`,
      [store.id, businessName]
    );

    // Seed default loyalty rule
    await client.query(
      `INSERT INTO loyalty_rules (store_id) VALUES ($1)`, [store.id]
    );

    const tokens = await createTokenPair(user, deviceId);
    return { store, user, tokens };
  });
}

// ─────────────────────────────────────────────
// LOGIN (existing user)
// ─────────────────────────────────────────────

async function loginWithOTP({ mobile, otp, deviceId }) {
  await verifyOTP(mobile, otp);

  const result = await db.query(
    `SELECT u.id, u.store_id, u.branch_id, u.role, u.role_level,
            u.name, u.is_active, u.fcm_token,
            s.is_suspended, s.subscription_status, s.subscription_tier
     FROM users u
     JOIN stores s ON s.id = u.store_id
     WHERE u.mobile = $1`,
    [mobile]
  );

  if (result.rows.length === 0) {
    throw new AppError('Mobile number not registered. Please sign up.', 404);
  }

  const user = result.rows[0];
  if (!user.is_active)       throw new AppError('Account deactivated. Contact your manager.', 403);
  if (user.is_suspended)     throw new AppError('Store account is suspended.', 403);

  // Update last login
  await db.query(
    `UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]
  );

  const tokens = await createTokenPair(user, deviceId);
  return { user, tokens };
}

// ─────────────────────────────────────────────
// REFRESH TOKEN
// ─────────────────────────────────────────────

async function refreshAccessToken(refreshToken, deviceId) {
  const { userId } = await verifyAndRotateRefreshToken(refreshToken);

  const result = await db.query(
    `SELECT u.id, u.store_id, u.branch_id, u.role, u.role_level, u.name, u.is_active
     FROM users u WHERE u.id = $1`,
    [userId]
  );

  if (!result.rows[0] || !result.rows[0].is_active) {
    throw new AppError('User not found or inactive', 401);
  }

  return createTokenPair(result.rows[0], deviceId);
}

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────

async function logout(userId) {
  await revokeAllUserTokens(userId);
  return { message: 'Logged out successfully' };
}

// ─────────────────────────────────────────────
// SUPER ADMIN LOGIN (separate auth flow)
// ─────────────────────────────────────────────

async function superAdminLogin({ email, password, totpCode, clientIp }) {
  const result = await db.query(
    `SELECT id, email, password_hash, totp_secret, allowed_ips, is_active
     FROM super_admin_users WHERE email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    // Timing attack prevention — always compare
    await bcrypt.compare(password, '$2b$12$invalidhashpadding');
    throw new AppError('Invalid credentials', 401);
  }

  const admin = result.rows[0];
  if (!admin.is_active) throw new AppError('Account inactive', 403);

  // IP whitelist
  if (admin.allowed_ips.length > 0 && !admin.allowed_ips.includes(clientIp)) {
    throw new AppError('Access denied from this IP', 403);
  }

  // Password check
  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) throw new AppError('Invalid credentials', 401);

  // TOTP verification (mandatory for super admin)
  totp.options = { step: 30, digits: 6 };
  const totpValid = totp.verify({ token: totpCode, secret: admin.totp_secret });
  if (!totpValid) throw new AppError('Invalid 2FA code', 401);

  // Update last login
  await db.query(
    `UPDATE super_admin_users SET last_login_at = NOW(), last_login_ip = $2 WHERE id = $1`,
    [admin.id, clientIp]
  );

  const token = signSuperAdminToken({
    sub:   admin.id,
    email: admin.email,
    type:  'super_admin',
  });

  return { token, expiresIn: 30 * 60 };
}

// ─────────────────────────────────────────────
// KYB — Update store documents
// ─────────────────────────────────────────────

async function updateKYB(storeId, { gstin, fssaiNumber, pan }) {
  // Validate GSTIN format
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)) {
    throw new AppError('Invalid GSTIN format', 400);
  }

  const result = await db.query(
    `UPDATE stores
     SET gstin = COALESCE($2, gstin),
         fssai_number = COALESCE($3, fssai_number),
         pan = COALESCE($4, pan),
         kyb_status = CASE
           WHEN $2 IS NOT NULL THEN 'under_review'
           ELSE kyb_status
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, kyb_status`,
    [storeId, gstin || null, fssaiNumber || null, pan || null]
  );

  return result.rows[0];
}

module.exports = {
  sendOTP,
  verifyOTP,
  registerStore,
  loginWithOTP,
  refreshAccessToken,
  logout,
  superAdminLogin,
  updateKYB,
};

// ─────────────────────────────────────────────
// SMS STUB (replace with MSG91 / Twilio)
// ─────────────────────────────────────────────
async function sendSMS(mobile, message) {
  // TODO: integrate MSG91
  logger.info(`SMS to ${mobile}: ${message}`);
}
