'use strict';
const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const svc = require('./admin.service');
const { authenticateSuperAdmin } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };
router.use(authenticateSuperAdmin);

router.get('/dashboard', async (req,res,next) => { try { res.json({success:true,data:(await svc.getDashboard())}); } catch(e){next(e);} });

router.patch('/tiers/:tier',
  [param('tier').isIn(['bronze','silver','gold']),
   body('monthly_price').optional().isFloat({min:0}),
   body('crm_limit').optional().isInt({min:1}),
   body('can_run_ads').optional().isBoolean()], v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.updateTierConfig(req.superAdmin.id,req.params.tier,req.body))}); } catch(e){next(e);} });

router.patch('/ad-rates/:placement', param('placement').isString(),
  [body('floor_cpc').optional().isFloat({min:0}), body('floor_cpm').optional().isFloat({min:0})], v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.updateAdRates(req.superAdmin.id,req.params.placement,req.body))}); } catch(e){next(e);} });

router.post('/campaigns/:id/approve', param('id').isUUID(), v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.approveAdCampaign(req.superAdmin.id,req.params.id))}); } catch(e){next(e);} });

router.post('/campaigns/:id/reject', param('id').isUUID(), [body('reason').trim().isLength({min:5})], v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.rejectAdCampaign(req.superAdmin.id,req.params.id,req.body.reason))}); } catch(e){next(e);} });

router.post('/stores/:id/suspend', param('id').isUUID(),
  [body('reason').trim().isLength({min:10}), body('days').optional().isInt({min:1})], v,
  async (req,res,next) => { try { await svc.suspendStore(req.superAdmin.id,req.params.id,req.body.ticket_id,req.body.reason,req.body.days); res.json({success:true,message:'Store suspended'}); } catch(e){next(e);} });

router.post('/customers/:id/credit', param('id').isUUID(),
  [body('amount').isFloat({min:1}), body('ticket_id').optional().isUUID()], v,
  async (req,res,next) => { try { await svc.issuePlatformCredit(req.superAdmin.id,req.params.id,req.body.ticket_id,req.body.amount); res.json({success:true,message:'Credit issued'}); } catch(e){next(e);} });

router.get('/grievances', async (req,res,next) => { try { res.json({success:true,data:(await svc.getEscalatedTickets(req.query.page,req.query.limit,req.query.severity))}); } catch(e){next(e);} });

module.exports = router;
