'use strict';
const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const svc = require('./inventory.service');
const { authenticate, requireRole, requireMinLevel } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };

router.use(authenticate);

router.get('/products', async (req,res,next) => {
  try { res.json({success:true,data:(await svc.getStockSummary(req.user.storeId, req.query.page, req.query.limit))}); } catch(e){next(e);} });

router.post('/products', requireMinLevel(4),
  [body('name').trim().isLength({min:1,max:255}), body('basePrice').isFloat({min:0}),
   body('unitType').optional().isIn(['piece','kg','gram','litre','ml','dozen','box']),
   body('gstRate').optional().isFloat()], v,
  async (req,res,next) => {
    try { res.status(201).json({success:true,data:(await svc.addProduct(req.user.storeId,req.user.id,req.body))}); } catch(e){next(e);} });

router.patch('/products/:id/price', requireMinLevel(5),
  [param('id').isUUID(), body('price').isFloat({min:0})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.updateProductPrice(req.user.storeId,req.params.id,req.body.price,req.user.id))}); } catch(e){next(e);} });

router.post('/products/:id/barcode', requireMinLevel(4), param('id').isUUID(), v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.generateCustomBarcode(req.user.storeId,req.params.id))}); } catch(e){next(e);} });

router.post('/stock/receive', requireRole('buyer','admin'),
  [body('batches').isArray({min:1}), body('batches.*.productId').isUUID(), body('batches.*.qty').isFloat({min:0.001})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.receiveStock(req.user.storeId,req.body.poId,req.body.batches))}); } catch(e){next(e);} });

router.get('/alerts/expiry', async (req,res,next) => {
  try { res.json({success:true,data:(await svc.getExpiryAlerts(req.user.storeId, req.query.days))}); } catch(e){next(e);} });

router.get('/alerts/low-stock', async (req,res,next) => {
  try { res.json({success:true,data:(await svc.getLowStockAlerts(req.user.storeId))}); } catch(e){next(e);} });

module.exports = router;
