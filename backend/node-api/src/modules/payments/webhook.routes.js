'use strict';
const router = require('express').Router();
const svc    = require('./payments.service');
const logger = require('../../utils/logger');

// Raw body is preserved by app.js for this route
router.post('/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing signature' });
    const result = await svc.handlePaymentWebhook(req.body, signature);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.warn('Webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// WhatsApp webhook verification (GET) + message receive (POST)
router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/whatsapp', (req, res) => {
  // Process incoming WA messages (order via catalog, etc.)
  logger.info('WhatsApp webhook:', JSON.stringify(req.body).slice(0, 200));
  res.sendStatus(200);
});

module.exports = router;
