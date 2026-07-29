'use strict';

const { verifyAccessToken, verifySuperAdminToken } = require('../utils/jwt');
const { db }    = require('../config/database');
const { redis, KEYS } = require('../config/redis');
const logger    = require('../utils/logger');
const AppError  = require('../utils/AppError');

// ─────────────────────────────────────────────
// AUTHENTICATE — validates JWT access token
// ─────────────────────────────────────────────

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('Missing or invalid Authorization header', 401);
    }

    const token   = header.split(' ')[1];
    const decoded = verifyAccessToken(token);

    // Check if store is suspended
    const storeCheck = await db.query(
      `SELECT is_suspended, subscription_status FROM stores WHERE id = $1`,
      [decoded.storeId]
    );
    if (!storeCheck.rows[0]) throw new AppError('Store not found', 404);
    if (storeCheck.rows[0].is_suspended) {
      throw new AppError('Store account is suspended. Contact support.', 403);
    }

    req.user = {
      id:        decoded.sub,
      storeId:   decoded.storeId,
      branchId:  decoded.branchId,
      role:      decoded.role,
      roleLevel: decoded.roleLevel,
      name:      decoded.name,
    };

    // Device fingerprint validation
    const deviceId = req.headers['x-device-id'];
    if (deviceId) req.deviceId = deviceId;

    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError')  return next(new AppError('Invalid token', 401));
    if (err.name === 'TokenExpiredError')  return next(new AppError('Token expired', 401));
    next(err);
  }
}

// ─────────────────────────────────────────────
// ROLE GUARDS
// ─────────────────────────────────────────────

/**
 * requireRole('admin') — exact role match
 * requireRole(['admin','finance']) — any of the listed roles
 */
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));
    if (allowed.includes(req.user.role)) return next();
    // Log the attempt
    logSecurityEvent(req, 'UNAUTHORIZED_ROLE_ACCESS', 'warning', {
      requiredRoles: allowed,
      actualRole:    req.user.role,
      endpoint:      req.originalUrl,
    });
    next(new AppError('Insufficient permissions', 403));
  };
}

/**
 * requireMinLevel(3) — role level >= n
 */
function requireMinLevel(minLevel) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));
    if (req.user.roleLevel >= minLevel) return next();
    next(new AppError('Insufficient permissions', 403));
  };
}

// ─────────────────────────────────────────────
// PRICE INTEGRITY GUARD
// Verifies that submitted prices match server-authoritative prices
// ─────────────────────────────────────────────

async function verifyPriceIntegrity(req, res, next) {
  try {
    const items = req.body.items || [];
    if (items.length === 0) return next();

    const productIds = items.map(i => i.product_id).filter(Boolean);
    if (productIds.length === 0) return next();

    const result = await db.query(
      `SELECT id, base_price, is_price_locked FROM products
       WHERE id = ANY($1) AND store_id = $2`,
      [productIds, req.user.storeId]
    );

    const priceMap = {};
    result.rows.forEach(p => { priceMap[p.id] = p; });

    for (const item of items) {
      const product = priceMap[item.product_id];
      if (!product) continue;
      if (!product.is_price_locked) continue;

      // Volume discount is allowed — but base_price must not be tampered directly
      // The effective_price is set by server-side DiscountRuleService
      if (item.submitted_price && Math.abs(item.submitted_price - product.base_price) > 0.01) {
        // Only flag if no volume rule was applied
        if (!item.applied_rule_id) {
          await logSecurityEvent(req, 'PRICE_TAMPER', 'critical', {
            product_id:      item.product_id,
            submitted_price: item.submitted_price,
            server_price:    product.base_price,
          });
          return next(new AppError('Price integrity violation detected', 400));
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// SUPER ADMIN AUTH
// ─────────────────────────────────────────────

async function authenticateSuperAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('Missing Authorization header', 401);
    }

    const token   = header.split(' ')[1];
    const decoded = verifySuperAdminToken(token);

    // IP whitelist check
    const clientIp = req.ip || req.connection.remoteAddress;
    const result   = await db.query(
      `SELECT id, email, allowed_ips, is_active FROM super_admin_users WHERE id = $1`,
      [decoded.sub]
    );

    if (!result.rows[0])         throw new AppError('Super admin not found', 404);
    const admin = result.rows[0];
    if (!admin.is_active)        throw new AppError('Account inactive', 403);

    if (admin.allowed_ips.length > 0 && !admin.allowed_ips.includes(clientIp)) {
      logger.warn(`Super admin IP blocked: ${clientIp} for admin ${admin.email}`);
      throw new AppError('Access denied from this IP address', 403);
    }

    req.superAdmin = { id: admin.id, email: admin.email };
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError')  return next(new AppError('Invalid token', 401));
    if (err.name === 'TokenExpiredError')  return next(new AppError('Session expired', 401));
    next(err);
  }
}

// ─────────────────────────────────────────────
// SUBSCRIPTION GATE
// Checks if store's tier allows the requested feature
// ─────────────────────────────────────────────

function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const { cacheGet, cacheSet, TTL, KEYS } = require('../config/redis');
      const tier    = (await db.query(
        `SELECT subscription_tier FROM stores WHERE id = $1`,
        [req.user.storeId]
      )).rows[0]?.subscription_tier || 'bronze';

      const cacheKey = KEYS.tierConfig(tier);
      let config = await cacheGet(cacheKey);

      if (!config) {
        const res2 = await db.query(
          `SELECT * FROM tier_config WHERE tier = $1`, [tier]
        );
        config = res2.rows[0];
        await cacheSet(cacheKey, config, TTL.TIER_CONFIG);
      }

      if (!config[featureKey]) {
        return next(new AppError(
          `This feature requires a higher subscription tier. Upgrade to access.`, 402
        ));
      }
      req.tierConfig = config;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ─────────────────────────────────────────────
// SECURITY EVENT LOGGER
// ─────────────────────────────────────────────

async function logSecurityEvent(req, eventType, severity = 'warning', meta = {}) {
  try {
    await db.query(
      `INSERT INTO security_event_log
         (store_id, user_id, event_type, severity, shift_id, meta, device_id, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.user?.storeId || null,
        req.user?.id      || null,
        eventType,
        severity,
        req.body?.shift_id || null,
        JSON.stringify(meta),
        req.deviceId || null,
        req.ip || null,
        req.headers['user-agent'] || null,
      ]
    );
  } catch (err) {
    logger.error('Failed to log security event:', err);
  }
}

module.exports = {
  authenticate,
  requireRole,
  requireMinLevel,
  verifyPriceIntegrity,
  authenticateSuperAdmin,
  requireFeature,
  logSecurityEvent,
};
