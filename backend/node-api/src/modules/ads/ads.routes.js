'use strict';
const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const svc = require('./ads.service');
const { authenticate, requireFeature } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };
router.use(authenticate);

router.post('/campaigns', requireFeature('can_run_ads'),
  [body('campaignName').trim().isLength({min:2,max:150}),
   body('campaignType').isIn(['b2c_retail','b2b_wholesale']),
   body('placement').isIn(['map_top','search_suggest','inbox_push','b2b_map_top','b2b_search']),
   body('dailyBudget').isFloat({min:100}), body('bidAmount').isFloat({min:0.01}),
   body('headline').trim().isLength({min:2,max:80}), body('startsAt').isDate()], v,
  async (req,res,next) => {
    try { res.status(201).json({success:true,data:(await svc.createCampaign(req.user.storeId,req.tierConfig||{can_run_ads:true},req.body))}); } catch(e){next(e);} });

router.get('/campaigns/:id/stats', param('id').isUUID(), v,
  async (req,res,next) => { try { res.json({success:true,data:(await svc.getCampaignStats(req.user.storeId,req.params.id))}); } catch(e){next(e);} });

// Public: ad serving (called by frontend map/search with viewer context)
router.get('/serve',
  [query('placement').isIn(['map_top','search_suggest','inbox_push','b2b_map_top','b2b_search']),
   query('lat').optional().isFloat(), query('lng').optional().isFloat()], v,
  async (req,res,next) => {
    try {
      const ad = await svc.runAdAuction(req.query.placement, req.query.lat, req.query.lng, req.query.viewer_type||'customer');
      if (ad) await svc.recordAdEvent(ad.id,'impression',req.query.viewer_type||'customer',null,req.query.lat,req.query.lng,0);
      res.json({success:true,data:ad});
    } catch(e){next(e);}
  });

router.post('/events', [body('campaign_id').isUUID(), body('event_type').isIn(['click','impression'])], v,
  async (req,res,next) => {
    try {
      const { campaign_id, event_type, viewer_id, lat, lng } = req.body;
      const ad = (await require('../../config/database').db.query(`SELECT bid_amount,bid_type FROM ad_campaigns WHERE id=$1`,[campaign_id])).rows[0];
      const charge = event_type==='click' && ad?.bid_type==='cpc' ? parseFloat(ad.bid_amount) : 0;
      await svc.recordAdEvent(campaign_id, event_type, 'customer', viewer_id, lat, lng, charge);
      res.json({success:true});
    } catch(e){next(e);}
  });

module.exports = router;
