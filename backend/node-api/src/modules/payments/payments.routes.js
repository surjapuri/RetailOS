'use strict';
const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const svc = require('./payments.service');
const { authenticate, requireMinLevel } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };

router.use(authenticate);

router.get('/upi-qr/:saleId', param('saleId').isUUID(), v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.generateUPIQR(req.user.storeId,req.params.saleId))}); } catch(e){next(e);} });

router.post('/record',
  [body('sale_id').isUUID(), body('method').isIn(['cash','upi','card','khata','platform_credit']),
   body('amount').isFloat({min:0.01})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.recordPayment(req.user.storeId,req.body.sale_id,req.body))}); } catch(e){next(e);} });

router.post('/subscription/create', requireMinLevel(5),
  [body('tier').isIn(['bronze','silver','gold'])], v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.createSubscription(req.user.storeId,req.body.tier))}); } catch(e){next(e);} });

module.exports = router;
