'use strict';
const router = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const svc = require('./crm.service');
const { authenticate, requireMinLevel, requireFeature } = require('../../middleware/auth');
const v = (req,res,next) => { const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };

router.use(authenticate);

router.get('/customers', async (req,res,next) => {
  try {
    const { db } = require('../../config/database');
    const { q, page=1, limit=20 } = req.query;
    const offset = (page-1)*limit;
    const params = [req.user.storeId, limit, offset];
    let where = '';
    if (q) { where = ' AND (c.name ILIKE $4 OR c.mobile ILIKE $4)'; params.push(`%${q}%`); }
    const r = await db.query(
      `SELECT c.*, (SELECT COALESCE(SUM(points),0) FROM loyalty_transactions WHERE customer_id=c.id AND store_id=c.store_id) AS points_balance
       FROM customers c WHERE c.store_id=$1 ${where} ORDER BY c.total_spend DESC LIMIT $2 OFFSET $3`, params);
    res.json({ success:true, data:r.rows, page:parseInt(page), limit:parseInt(limit) });
  } catch(e){next(e);}
});

router.post('/customers/lookup',
  [body('mobile').trim().matches(/^[6-9]\d{9}$/)], v,
  async (req,res,next) => {
    try {
      const r = await svc.findOrCreateCustomer(req.user.storeId, req.body.mobile, req.body.name);
      res.json({ success:true, data:r });
    } catch(e){next(e);}
  });

router.get('/customers/:id', param('id').isUUID(), v, async (req,res,next) => {
  try { res.json({ success:true, data:(await svc.getCustomerProfile(req.params.id, req.user.storeId)) }); } catch(e){next(e);}
});

router.post('/customers/:id/consent', param('id').isUUID(), [body('action').isIn(['consent_given','opt_out','re_consent'])], v,
  async (req,res,next) => {
    try {
      await svc.recordConsent(req.params.id, req.body.action, req.user.id, req.ip, req.deviceId);
      res.json({ success:true, message:'Consent recorded' });
    } catch(e){next(e);}
  });

router.get('/customers/:id/inbox', param('id').isUUID(), v, async (req,res,next) => {
  try { res.json({ success:true, data:(await svc.getCustomerInbox(req.params.id, req.user.storeId, req.query.page, req.query.limit)) }); } catch(e){next(e);}
});

router.get('/customers/:id/points', param('id').isUUID(), v, async (req,res,next) => {
  try { res.json({ success:true, data:{ balance:(await svc.getPointsBalance(req.params.id, req.user.storeId)) } }); } catch(e){next(e);}
});

router.post('/customers/:id/points/redeem',
  [param('id').isUUID(), body('sale_id').isUUID(), body('points').isInt({min:1})], v,
  async (req,res,next) => {
    try { res.json({ success:true, data:(await svc.redeemPoints(req.params.id, req.user.storeId, req.body.sale_id, req.body.points)) }); } catch(e){next(e);}
  });

router.post('/broadcast', requireMinLevel(5), requireFeature('can_run_ads'),
  [body('title').trim().isLength({min:2,max:200}), body('body').trim().isLength({min:2}),
   body('segment').optional().isIn(['all','khata','high_spend','recent_30d'])], v,
  async (req,res,next) => {
    try { res.json({ success:true, data:(await svc.sendBroadcast(req.user.storeId, req.body)) }); } catch(e){next(e);}
  });

module.exports = router;
