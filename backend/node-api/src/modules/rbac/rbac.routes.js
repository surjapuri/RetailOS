'use strict';
const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const svc = require('./rbac.service');
const { authenticate, requireMinLevel } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };
router.use(authenticate);

router.post('/supervisor/request',
  [body('terminal_id').optional().trim()], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.requestSupervisorSession(req.user.storeId,req.user.id,req.body.terminal_id||req.deviceId))}); } catch(e){next(e);} });

router.post('/supervisor/validate/card',
  [body('card_scan').trim().isLength({min:10})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.validateSupervisorCard(req.user.storeId,req.user.id,req.body.terminal_id,req.body.card_scan))}); } catch(e){next(e);} });

router.post('/supervisor/validate/pin',
  [body('supervisor_id').isUUID(), body('pin').isLength({min:6,max:6})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.validateRollingPin(req.user.storeId,req.user.id,req.body.terminal_id,req.body.supervisor_id,req.body.pin))}); } catch(e){next(e);} });

router.post('/supervisor/validate/biometric',
  [body('supervisor_id').isUUID()], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.validateBiometric(req.user.storeId,req.user.id,req.body.terminal_id,req.body.supervisor_id,req.body.biometric_token))}); } catch(e){next(e);} });

router.post('/employees', requireMinLevel(5),
  [body('name').trim().isLength({min:2}), body('mobile').trim().matches(/^[6-9]\d{9}$/),
   body('role').isIn(['cashier','head_cashier','buyer','finance','admin'])], v,
  async (req,res,next) => {
    try { res.status(201).json({success:true,data:(await svc.createEmployee(req.user.storeId,req.user.id,req.body))}); } catch(e){next(e);} });

router.post('/employees/:id/supervisor-card', requireMinLevel(5), param('id').isUUID(), v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.generateSupervisorCard(req.params.id,req.user.storeId))}); } catch(e){next(e);} });

router.post('/employees/:id/totp', requireMinLevel(5), param('id').isUUID(), v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.generateTOTPSecret(req.params.id,req.user.storeId))}); } catch(e){next(e);} });

module.exports = router;
