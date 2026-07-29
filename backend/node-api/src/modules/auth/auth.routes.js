'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const svc = require('./auth.service');
const { authenticate, requireMinLevel } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const AppError = require('../../utils/AppError');

const v = (req,res,next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ success:false, errors:e.array() });
  next();
};

router.post('/otp/send', rateLimiter.otp,
  [body('mobile').trim().matches(/^[6-9]\d{9}$/).withMessage('Invalid Indian mobile number')], v,
  async (req,res,next) => { try { res.json({ success:true, ...(await svc.sendOTP(req.body.mobile)) }); } catch(e){next(e);} });

router.post('/register',
  [body('mobile').trim().matches(/^[6-9]\d{9}$/), body('otp').trim().isLength({min:6,max:6}),
   body('businessName').trim().isLength({min:2,max:200})], v,
  async (req,res,next) => {
    try {
      const r = await svc.registerStore({ businessName:req.body.businessName, ownerMobile:req.body.mobile,
        otp:req.body.otp, deviceId:req.headers['x-device-id'] });
      res.status(201).json({ success:true, data:r });
    } catch(e){next(e);}
  });

router.post('/login',
  [body('mobile').trim().matches(/^[6-9]\d{9}$/), body('otp').trim().isLength({min:6,max:6})], v,
  async (req,res,next) => {
    try {
      const r = await svc.loginWithOTP({ mobile:req.body.mobile, otp:req.body.otp, deviceId:req.headers['x-device-id'] });
      res.json({ success:true, data:r });
    } catch(e){next(e);}
  });

router.post('/refresh', async (req,res,next) => {
  try {
    if (!req.body.refreshToken) throw new AppError('Refresh token required',400);
    const r = await svc.refreshAccessToken(req.body.refreshToken, req.headers['x-device-id']);
    res.json({ success:true, data:r });
  } catch(e){next(e);}
});

router.post('/logout', authenticate, async (req,res,next) => {
  try { res.json({ success:true, ...(await svc.logout(req.user.id)) }); } catch(e){next(e);}
});

router.put('/kyb', authenticate, requireMinLevel(5),
  [body('gstin').optional().trim().isLength({min:15,max:15}),
   body('fssaiNumber').optional().trim(), body('pan').optional().trim().isLength({min:10,max:10})], v,
  async (req,res,next) => {
    try { res.json({ success:true, data:(await svc.updateKYB(req.user.storeId,req.body)) }); } catch(e){next(e);}
  });

router.get('/me', authenticate, (req,res) => res.json({ success:true, data:req.user }));

router.post('/superadmin/login', rateLimiter.superAdmin,
  [body('email').isEmail(), body('password').isLength({min:8}), body('totpCode').isLength({min:6,max:6})], v,
  async (req,res,next) => {
    try {
      const r = await svc.superAdminLogin({ ...req.body, clientIp:req.ip });
      res.json({ success:true, data:r });
    } catch(e){next(e);}
  });

module.exports = router;
