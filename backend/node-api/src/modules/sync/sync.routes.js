'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const posService = require('../pos/pos.service');
const { authenticate } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };
router.use(authenticate);

router.post('/bills', [body('bills').isArray({min:1,max:50}), body('bills.*.offlineId').isUUID()], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await posService.syncOfflineBatch(req.user.storeId,req.user.branchId,req.deviceId,req.body.bills))}); } catch(e){next(e);} });

router.get('/catalog', async (req,res,next) => {
  try {
    const { db } = require('../../config/database');
    const since  = req.query.since ? new Date(req.query.since) : new Date(0);
    const r = await db.query(
      `SELECT id,plu_code,barcode,internal_barcode,name,name_local,base_price,mrp,
              hsn_code,gst_rate,unit_type,is_loose,is_price_locked,stock_qty,low_stock_at,category
       FROM products WHERE store_id=$1 AND is_active=TRUE AND updated_at>$2 ORDER BY name`,
      [req.user.storeId, since]);
    const rules = await db.query(
      `SELECT * FROM volume_discount_rules WHERE store_id=$1 AND is_active=TRUE
       AND (valid_from IS NULL OR valid_from<=CURRENT_DATE) AND (valid_to IS NULL OR valid_to>=CURRENT_DATE)`,
      [req.user.storeId]);
    res.json({success:true,data:{products:r.rows,volume_rules:rules.rows,synced_at:new Date().toISOString()}});
  } catch(e){next(e);}
});

module.exports = router;
