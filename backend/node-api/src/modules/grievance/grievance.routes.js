'use strict';
const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const svc = require('./grievance.service');
const { authenticate } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };
router.use(authenticate);

router.post('/',
  [body('respondent_id').isUUID(), body('respondent_type').isIn(['retailer','wholesaler']),
   body('type').isIn(['b2c','b2b']), body('category').trim().isLength({min:2,max:60}),
   body('description').trim().isLength({min:10}), body('evidence_urls').optional().isArray()], v,
  async (req,res,next) => {
    try {
      const { respondent_id, respondent_type, type, category, description, evidence_urls, sale_id, po_id } = req.body;
      const r = await svc.createTicket({
        complainantId:   req.user.id,
        complainantType: 'retailer',
        respondentId: respondent_id, respondentType: respondent_type,
        type, category, description, evidenceUrls: evidence_urls, saleId: sale_id, poId: po_id,
      });
      res.status(201).json({success:true,data:r});
    } catch(e){next(e);}
  });

router.get('/', async (req,res,next) => {
  try { res.json({success:true,data:(await svc.getTickets(req.user.id,'retailer',req.query.page,req.query.limit,req.query.status))}); } catch(e){next(e);} });

router.post('/:id/messages', param('id').isUUID(), [body('message').trim().isLength({min:1})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.addMessage(req.params.id,req.user.id,'retailer',req.body.message,req.body.attachments))}); } catch(e){next(e);} });

router.put('/:id/resolve', param('id').isUUID(), [body('resolution_note').trim().isLength({min:5})], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.resolveTicket(req.params.id,req.body.resolution_note))}); } catch(e){next(e);} });

module.exports = router;
