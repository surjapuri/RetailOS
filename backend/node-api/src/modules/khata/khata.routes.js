'use strict';
const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const svc = require('./khata.service');
const { authenticate, requireMinLevel } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };
router.use(authenticate);

router.get('/customers/:id/statement', param('id').isUUID(), v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.getKhataStatement(req.params.id,req.user.storeId,req.query.page,req.query.limit))}); } catch(e){next(e);} });

router.post('/customers/:id/pay', param('id').isUUID(),
  [body('amount').isFloat({min:0.01}), body('notes').optional().trim()], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.recordKhataPayment(req.params.id,req.user.storeId,req.body.amount,req.body.notes,req.user.id))}); } catch(e){next(e);} });

router.get('/ageing-report', requireMinLevel(3),
  async (req,res,next) => { try { res.json({success:true,data:(await svc.getKhataAgeingReport(req.user.storeId))}); } catch(e){next(e);} });

module.exports = router;
