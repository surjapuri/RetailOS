'use strict';

const router     = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const posService = require('./pos.service');
const { authenticate, requireRole, requireMinLevel, verifyPriceIntegrity } = require('../../middleware/auth');
const AppError   = require('../../utils/AppError');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 422));
  next();
};

// All POS routes require authentication
router.use(authenticate);

// ── GET /api/v1/pos/products/catalog ──────────────────────────
// Full catalog for offline sync (POS terminal downloads on startup)
router.get('/products/catalog',
  query('updatedSince').optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const products = await posService.getProductCatalog(
        req.user.storeId,
        { updatedSince: req.query.updatedSince }
      );
      res.json({ success: true, data: products, count: products.length });
    } catch (err) { next(err); }
  }
);

// ── GET /api/v1/pos/products/lookup ───────────────────────────
// Single product lookup by barcode, PLU, or ID
router.get('/products/lookup',
  query('barcode').optional().trim(),
  query('pluCode').optional().trim(),
  query('productId').optional().isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { barcode, pluCode, productId } = req.query;
      if (!barcode && !pluCode && !productId) {
        return next(new AppError('Provide barcode, pluCode, or productId', 400));
      }
      const product = await posService.lookupProduct(req.user.storeId, { barcode, pluCode, productId });
      if (!product) return next(new AppError('Product not found', 404));
      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  }
);

// ── POST /api/v1/pos/bill/calculate ───────────────────────────
// Preview bill with server-calculated totals (for cart display)
router.post('/bill/calculate',
  body('items').isArray({ min: 1 }).withMessage('Items array required'),
  body('items.*.product_id').isUUID().withMessage('Valid product_id required'),
  body('items.*.quantity').isFloat({ gt: 0 }).withMessage('Quantity must be > 0'),
  body('customerId').optional().isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const bill = await posService.calculateBill(
        req.user.storeId,
        req.body.items,
        { customerId: req.body.customerId }
      );
      res.json({ success: true, data: bill });
    } catch (err) { next(err); }
  }
);

// ── POST /api/v1/pos/sales ────────────────────────────────────
// Create a new sale
router.post('/sales',
  requireRole('cashier','head_cashier','admin'),
  body('items').isArray({ min: 1 }),
  body('items.*.product_id').isUUID(),
  body('items.*.quantity').isFloat({ gt: 0 }),
  body('shiftId').isUUID().withMessage('Active shift ID required'),
  body('branchId').isUUID().withMessage('Branch ID required'),
  body('customerId').optional().isUUID(),
  body('isGstBill').optional().isBoolean(),
  body('discountAmount').optional().isFloat({ min: 0 }),
  body('redeemPoints').optional().isInt({ min: 0 }),
  body('offlineAt').optional().isISO8601(),
  validate,
  verifyPriceIntegrity,
  async (req, res, next) => {
    try {
      const result = await posService.createSale(
        req.user.storeId,
        req.body.branchId,
        req.user.id,
        req.body.shiftId,
        {
          items:              req.body.items,
          customerId:         req.body.customerId,
          isGstBill:          req.body.isGstBill,
          buyerGstin:         req.body.buyerGstin,
          placeOfSupply:      req.body.placeOfSupply,
          discountAmount:     req.body.discountAmount || 0,
          discountReason:     req.body.discountReason,
          discountApprovedBy: req.body.discountApprovedBy,
          redeemPoints:       req.body.redeemPoints || 0,
          deviceId:           req.deviceId,
          offlineAt:          req.body.offlineAt,
        }
      );

      // Queue post-sale jobs (receipt, loyalty notification)
      const { getQueue } = require('../../config/queues');
      await getQueue('notifications').add('post_sale', {
        saleId:     result.sale.id,
        customerId: req.body.customerId,
        storeId:    req.user.storeId,
        invoiceNum: result.invoiceNumber,
        total:      result.sale.total_amount,
      }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });

      res.status(201).json({ success: true, data: result });
    } catch (err) { next(err); }
  }
);

// ── POST /api/v1/pos/sales/:saleId/void ───────────────────────
// Void a sale (requires supervisor session)
router.post('/sales/:saleId/void',
  param('saleId').isUUID(),
  body('supervisorSessionId').isUUID().withMessage('Supervisor session required'),
  body('reason').trim().isLength({ min: 5, max: 200 }).withMessage('Void reason required'),
  body('shiftId').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      // Validate supervisor session (one-time use, 60s expiry)
      const { db } = require('../../config/database');
      const sessRes = await db.query(
        `SELECT * FROM supervisor_sessions
         WHERE id=$1 AND used=FALSE AND expires_at > NOW()`,
        [req.body.supervisorSessionId]
      );
      if (!sessRes.rows[0]) {
        return next(new AppError('Invalid or expired supervisor session', 403));
      }
      const sess = sessRes.rows[0];

      // Mark session as used
      await db.query(
        `UPDATE supervisor_sessions SET used=TRUE, used_at=NOW() WHERE id=$1`,
        [sess.id]
      );

      const result = await posService.voidSale(
        req.user.storeId,
        req.params.saleId,
        {
          supervisorId: sess.supervisor_id,
          authMethod:   sess.auth_method,
          reason:       req.body.reason,
          cashierId:    req.user.id,
          shiftId:      req.body.shiftId,
          deviceId:     req.deviceId,
          ip:           req.ip,
        }
      );
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  }
);

// ── POST /api/v1/pos/shifts/open ──────────────────────────────
router.post('/shifts/open',
  requireRole('head_cashier','admin'),
  body('branchId').isUUID(),
  body('openingCash').isFloat({ min: 0 }).withMessage('Opening cash amount required'),
  body('terminalId').optional().trim(),
  validate,
  async (req, res, next) => {
    try {
      const shift = await posService.openShift(
        req.user.storeId,
        req.body.branchId,
        req.user.id,
        req.body.terminalId,
        req.body.openingCash
      );
      res.status(201).json({ success: true, data: shift });
    } catch (err) { next(err); }
  }
);

// ── POST /api/v1/pos/shifts/:shiftId/close ────────────────────
router.post('/shifts/:shiftId/close',
  requireRole('head_cashier','admin'),
  param('shiftId').isUUID(),
  body('closingCash').isFloat({ min: 0 }),
  validate,
  async (req, res, next) => {
    try {
      const result = await posService.closeShift(
        req.user.storeId,
        req.params.shiftId,
        req.user.id,
        req.body.closingCash
      );
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  }
);

// ── GET /api/v1/pos/sales/:saleId ─────────────────────────────
router.get('/sales/:saleId',
  param('saleId').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { db } = require('../../config/database');
      const res2   = await db.query(
        `SELECT s.*, json_agg(si.*) AS items
         FROM sales s
         LEFT JOIN sale_items si ON si.sale_id = s.id
         WHERE s.id=$1 AND s.store_id=$2
         GROUP BY s.id`,
        [req.params.saleId, req.user.storeId]
      );
      if (!res2.rows[0]) return next(new AppError('Sale not found', 404));
      res.json({ success: true, data: res2.rows[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
