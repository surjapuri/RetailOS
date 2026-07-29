'use strict';
const router = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const svc = require('./geo.service');
const { authenticate } = require('../../middleware/auth');
const v = (req,res,next)=>{ const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({success:false,errors:e.array()}); next(); };

// Public discovery endpoints
router.get('/discover',
  [query('lat').isFloat(), query('lng').isFloat(),
   query('radius').optional().isFloat({min:0.5,max:20}),
   query('mode').optional().isIn(['b2c','b2b'])], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.discoverStores(req.query.lat,req.query.lng,req.query.radius,req.query.mode||'b2c'))}); } catch(e){next(e);} });

router.get('/offers',
  [query('lat').isFloat(), query('lng').isFloat(), query('radius').optional().isFloat()], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.getNearbyOffers(req.query.lat,req.query.lng,req.query.radius))}); } catch(e){next(e);} });

router.get('/store/:id/profile', param('id').isUUID(),
  [query('branch_id').isUUID()], v,
  async (req,res,next) => {
    try { res.json({success:true,data:(await svc.getStoreProfile(req.params.id,req.query.branch_id))}); } catch(e){next(e);} });

// Authenticated — customer rating
router.post('/store/:id/rate', authenticate,
  [param('id').isUUID(), body('sale_id').isUUID(),
   body('rating').isInt({min:1,max:5}), body('review').optional().trim().isLength({max:500})], v,
  async (req,res,next) => {
    try {
      const { getCustomerProfile } = require('../crm/crm.service');
      const custR = await require('../../config/database').db.query(
        `SELECT id FROM customers WHERE store_id=$1 AND mobile=(SELECT mobile FROM users WHERE id=$2)`,
        [req.params.id, req.user.id]);
      const customerId = custR.rows[0]?.id;
      if (!customerId) return res.status(400).json({success:false,message:'Customer record not found'});
      res.json({success:true,data:(await svc.submitRating(req.params.id,customerId,req.body.sale_id,req.body.rating,req.body.review))});
    } catch(e){next(e);}
  });

module.exports = router;
