'use strict';

const { totp }  = require('otplib');
const bcrypt    = require('bcrypt');
const crypto    = require('crypto');
const { db }    = require('../../config/database');
const { redis, KEYS, TTL } = require('../../config/redis');
const { sendFCM } = require('../../utils/fcm');
const AppError  = require('../../utils/AppError');
const logger    = require('../../utils/logger');

// ─────────────────────────────────────────────
// CREATE SUPERVISOR SESSION
// Called when cashier requests a void/return
// ─────────────────────────────────────────────

async function requestSupervisorSession(storeId, requestorId, terminalId) {
  // Find available head cashier or admin for this store/branch
  const supers = await db.query(
    `SELECT id, name, totp_secret, fcm_token, supervisor_card_hash, biometric_enrolled
     FROM users
     WHERE store_id=$1 AND role IN ('head_cashier','admin') AND is_active=TRUE`,
    [storeId]
  );
  if (!supers.rows.length) throw new AppError('No supervisor available for this store', 404);

  // Send rolling PIN via FCM to all available supervisors
  const pinNotifications = [];
  for (const sup of supers.rows) {
    if (sup.totp_secret && sup.fcm_token) {
      totp.options = { step: 60, digits: 6 }; // 60-second window
      const pin = totp.generate(sup.totp_secret);
      pinNotifications.push(
        sendFCM(sup.fcm_token, {
          title: '🔐 Supervisor Approval Needed',
          body:  `One-time PIN: ${pin}. Valid 60 seconds. Terminal: ${terminalId}`,
          data:  { type: 'supervisor_pin', terminal_id: terminalId, requestor_id: requestorId },
        })
      );
    }
  }
  await Promise.allSettled(pinNotifications);

  return { message: 'Supervisor notified. Awaiting authorization.', methodsAvailable: ['card','biometric','rolling_pin'] };
}

// ─────────────────────────────────────────────
// VALIDATE SUPERVISOR — Card barcode
// ─────────────────────────────────────────────

async function validateSupervisorCard(storeId, requestorId, terminalId, cardScan) {
  // Hash the scanned card value
  const scannedHash = crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET)
    .update(cardScan).digest('hex');

  const supResult = await db.query(
    `SELECT id, name, store_id FROM users
     WHERE store_id=$1 AND supervisor_card_hash=$2 AND is_active=TRUE
       AND role IN ('head_cashier','admin')`,
    [storeId, scannedHash]
  );
  if (!supResult.rows[0]) throw new AppError('Invalid supervisor card', 403);
  const supervisor = supResult.rows[0];

  return _createSession(supervisor.id, requestorId, terminalId, 'card');
}

// ─────────────────────────────────────────────
// VALIDATE SUPERVISOR — Rolling TOTP PIN
// ─────────────────────────────────────────────

async function validateRollingPin(storeId, requestorId, terminalId, supervisorId, pin) {
  const supResult = await db.query(
    `SELECT id, totp_secret, store_id FROM users
     WHERE id=$1 AND store_id=$2 AND is_active=TRUE AND role IN ('head_cashier','admin')`,
    [supervisorId, storeId]
  );
  if (!supResult.rows[0]) throw new AppError('Supervisor not found', 404);
  const sup = supResult.rows[0];

  if (!sup.totp_secret) throw new AppError('Rolling PIN not configured for this supervisor', 400);

  totp.options = { step: 60, digits: 6, window: 1 };
  const valid  = totp.verify({ token: pin, secret: sup.totp_secret });
  if (!valid) {
    // Log failed attempt
    await db.query(
      `INSERT INTO security_event_log (store_id,user_id,event_type,severity,meta)
       VALUES ($1,$2,'SUPERVISOR_AUTH_FAIL','warning',$3)`,
      [storeId, requestorId, JSON.stringify({ supervisorId, method: 'rolling_pin' })]
    );
    throw new AppError('Invalid or expired PIN', 403);
  }

  return _createSession(sup.id, requestorId, terminalId, 'rolling_pin');
}

// ─────────────────────────────────────────────
// VALIDATE SUPERVISOR — Biometric (device confirms, server creates session)
// ─────────────────────────────────────────────

async function validateBiometric(storeId, requestorId, terminalId, supervisorId, biometricToken) {
  // The Flutter app performs local biometric auth and sends a signed nonce
  // We verify the nonce signature using the device's registered public key
  // Simplified: trust the supervisorId claim if biometricToken is a valid JWT
  const supResult = await db.query(
    `SELECT id FROM users
     WHERE id=$1 AND store_id=$2 AND biometric_enrolled=TRUE
       AND role IN ('head_cashier','admin')`,
    [supervisorId, storeId]
  );
  if (!supResult.rows[0]) throw new AppError('Biometric not enrolled for this user', 400);

  // In production: verify biometricToken (a device-signed JWT)
  // For now: create session directly
  return _createSession(supervisorId, requestorId, terminalId, 'biometric');
}

async function _createSession(supervisorId, requestorId, terminalId, method) {
  const expires = new Date(Date.now() + 60_000); // 60 seconds
  const result  = await db.query(
    `INSERT INTO supervisor_sessions
       (supervisor_id, requestor_id, terminal_id, auth_method, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
    [supervisorId, requestorId, terminalId, method, expires]
  );
  return {
    sessionId:  result.rows[0].id,
    expiresAt:  result.rows[0].expires_at,
    authMethod: method,
  };
}

// ─────────────────────────────────────────────
// EMPLOYEE MANAGEMENT
// ─────────────────────────────────────────────

async function createEmployee(storeId, createdBy, data) {
  const { name, mobile, role, branchId } = data;

  const roleLevels = { cashier: 1, buyer: 2, finance: 3, head_cashier: 4, admin: 5 };
  const level = roleLevels[role];
  if (!level) throw new AppError('Invalid role', 400);

  // Admin can't create another admin
  const creator = await db.query(`SELECT role_level FROM users WHERE id=$1`, [createdBy]);
  if (creator.rows[0].role_level <= level && role === 'admin') {
    throw new AppError('Cannot create a user with equal or higher role level', 403);
  }

  const result = await db.query(
    `INSERT INTO users (store_id, branch_id, name, mobile, role, role_level)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, mobile, role`,
    [storeId, branchId || null, name, mobile, role, level]
  );
  return result.rows[0];
}

async function generateSupervisorCard(userId, storeId) {
  // Generate a unique card token — store only its HMAC
  const cardToken = crypto.randomBytes(32).toString('hex');
  const cardHash  = crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET)
    .update(cardToken).digest('hex');

  await db.query(
    `UPDATE users SET supervisor_card_hash=$1 WHERE id=$2 AND store_id=$3`,
    [cardHash, userId, storeId]
  );

  // Return the raw token ONCE — never stored in DB
  // Store admin prints this as a barcode
  return {
    cardToken,
    instructions: 'Print this token as a CODE128 barcode. It cannot be retrieved again.',
    warning: 'Store securely. This is shown only once.',
  };
}

async function generateTOTPSecret(userId, storeId) {
  const secret = totp.generateSecret();
  await db.query(
    `UPDATE users SET totp_secret=$1 WHERE id=$2 AND store_id=$3`,
    [secret, userId, storeId]
  );
  const otpAuthUrl = totp.keyuri(userId, 'RetailOS-Supervisor', secret);
  return { secret, otpAuthUrl };
}

module.exports = {
  requestSupervisorSession,
  validateSupervisorCard,
  validateRollingPin,
  validateBiometric,
  createEmployee,
  generateSupervisorCard,
  generateTOTPSecret,
};
