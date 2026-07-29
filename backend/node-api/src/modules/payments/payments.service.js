'use strict';

const crypto    = require('crypto');
const Razorpay  = require('razorpay');
const QRCode    = require('qrcode');
const { db }    = require('../../config/database');
const AppError  = require('../../utils/AppError');
const logger    = require('../../utils/logger');
const { getIO } = require('../../socket/socketServer');

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────
// UPI QR GENERATION
// ─────────────────────────────────────────────

async function generateUPIQR(storeId, saleId) {
  // Fetch store VPA and sale amount
  const result = await db.query(
    `SELECT s.total_amount, s.invoice_number, s.payment_status,
            st.business_name
     FROM sales s
     JOIN stores st ON st.id = s.store_id
     WHERE s.id=$1 AND s.store_id=$2`,
    [saleId, storeId]
  );
  if (!result.rows[0]) throw new AppError('Sale not found', 404);
  const { total_amount, invoice_number, business_name, payment_status } = result.rows[0];

  if (payment_status === 'paid') throw new AppError('Bill already paid', 400);

  // Get store VPA from integrations (stored encrypted)
  const vpaResult = await db.query(
    `SELECT upi_vpa FROM store_payment_settings WHERE store_id=$1`, [storeId]
  );
  const vpa = vpaResult.rows[0]?.upi_vpa;
  if (!vpa) throw new AppError('UPI VPA not configured for this store', 400);

  const upiString = `upi://pay?pa=${encodeURIComponent(vpa)}`
    + `&pn=${encodeURIComponent(business_name)}`
    + `&am=${parseFloat(total_amount).toFixed(2)}`
    + `&tr=${encodeURIComponent(invoice_number)}`
    + `&tn=${encodeURIComponent('Payment for ' + invoice_number)}`
    + `&cu=INR`;

  // Generate QR as base64 data URL (client renders it)
  const qrDataURL = await QRCode.toDataURL(upiString, {
    errorCorrectionLevel: 'M',
    width: 400,
    margin: 2,
  });

  return {
    upiString,
    qrDataURL,
    amount:         total_amount,
    invoiceNumber:  invoice_number,
    expiresInSec:   90,
  };
}

// ─────────────────────────────────────────────
// CREATE RAZORPAY ORDER (for SDK-based flow)
// ─────────────────────────────────────────────

async function createRazorpayOrder(storeId, saleId) {
  const result = await db.query(
    `SELECT total_amount, invoice_number FROM sales WHERE id=$1 AND store_id=$2`,
    [saleId, storeId]
  );
  if (!result.rows[0]) throw new AppError('Sale not found', 404);
  const { total_amount, invoice_number } = result.rows[0];

  const order = await razorpay.orders.create({
    amount:          Math.round(parseFloat(total_amount) * 100), // in paise
    currency:        'INR',
    receipt:         invoice_number,
    payment_capture: true,
    notes:           { sale_id: saleId, store_id: storeId },
  });

  // Store order reference
  await db.query(
    `INSERT INTO payments (sale_id, store_id, method, amount, status, gateway, gateway_order_id)
     VALUES ($1,$2,'upi',$3,'pending','razorpay',$4)
     ON CONFLICT DO NOTHING`,
    [saleId, storeId, total_amount, order.id]
  );

  return { orderId: order.id, amount: total_amount, currency: 'INR' };
}

// ─────────────────────────────────────────────
// RAZORPAY WEBHOOK HANDLER
// Called by the webhook route with raw body
// ─────────────────────────────────────────────

async function handleRazorpayWebhook(rawBody, signature) {
  // Verify HMAC-SHA256 signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (signature !== expectedSig) {
    logger.warn('Razorpay webhook signature mismatch');
    throw new AppError('Invalid webhook signature', 400);
  }

  const event   = JSON.parse(rawBody.toString());
  const payload = event.payload?.payment?.entity || event.payload?.subscription?.entity;

  logger.info(`Razorpay webhook: ${event.event}`, { event: event.event });

  switch (event.event) {
    case 'payment.captured':
      await handlePaymentCaptured(payload);
      break;
    case 'payment.failed':
      await handlePaymentFailed(payload);
      break;
    case 'subscription.charged':
      await handleSubscriptionCharged(payload);
      break;
    case 'subscription.halted':
      await handleSubscriptionHalted(payload);
      break;
    default:
      logger.info(`Unhandled Razorpay event: ${event.event}`);
  }

  return { received: true };
}

async function handlePaymentCaptured(payment) {
  const { order_id, id: gatewayTxnId, method, vpa, amount,
          card, bank, error_description } = payment;

  // Find the sale via order ID
  const payRes = await db.query(
    `SELECT p.id, p.sale_id, p.store_id, s.branch_id, s.customer_id, s.invoice_number
     FROM payments p
     JOIN sales s ON s.id = p.sale_id
     WHERE p.gateway_order_id=$1 AND p.status='pending'`,
    [order_id]
  );
  if (!payRes.rows[0]) {
    logger.warn(`No pending payment found for order ${order_id}`);
    return;
  }
  const pay = payRes.rows[0];

  // Determine payment method details
  const payMethod  = method === 'upi' ? 'upi' : method === 'card' ? 'card' : 'upi';
  const amountRupees = amount / 100;

  await db.transaction(async (client) => {
    // Update payment record
    await client.query(
      `UPDATE payments SET
         status='paid', gateway_txn_id=$1, method=$2,
         upi_vpa_payer=$3, card_last4=$4, card_scheme=$5,
         webhook_raw=$6, paid_at=NOW()
       WHERE id=$7`,
      [
        gatewayTxnId, payMethod,
        vpa || null,
        card?.last4 || null, card?.network?.toLowerCase() || null,
        JSON.stringify(payment),
        pay.id,
      ]
    );

    // Mark sale as paid
    await client.query(
      `UPDATE sales SET payment_status='paid' WHERE id=$1`, [pay.sale_id]
    );

    // Update shift payment breakdown
    await client.query(
      `UPDATE shifts SET
         upi_sales  = upi_sales  + CASE WHEN $2='upi'  THEN $3 ELSE 0 END,
         card_sales = card_sales + CASE WHEN $2='card' THEN $3 ELSE 0 END
       WHERE id = (SELECT shift_id FROM sales WHERE id=$1)`,
      [pay.sale_id, payMethod, amountRupees]
    );
  });

  // 🔊 Emit real-time event to POS terminal via Socket.io
  const io = getIO();
  if (io) {
    io.to(`store:${pay.store_id}`).emit('payment_confirmed', {
      saleId:        pay.sale_id,
      invoiceNumber: pay.invoice_number,
      amount:        amountRupees,
      method:        payMethod,
      payerVpa:      vpa,
      timestamp:     new Date().toISOString(),
    });
  }

  // Queue post-payment jobs (receipt PDF, WhatsApp/Inbox notification)
  const { getQueue } = require('../../config/queues');
  await getQueue('notifications').add('payment_confirmed', {
    saleId:     pay.sale_id,
    customerId: pay.customer_id,
    storeId:    pay.store_id,
    amount:     amountRupees,
    method:     payMethod,
  }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });

  logger.info(`Payment captured: ${gatewayTxnId} for sale ${pay.sale_id}`);
}

async function handlePaymentFailed(payment) {
  if (!payment.order_id) return;
  await db.query(
    `UPDATE payments SET status='failed', webhook_raw=$1 WHERE gateway_order_id=$2`,
    [JSON.stringify(payment), payment.order_id]
  );

  // Notify POS of failure
  const io = getIO();
  if (io && payment.notes?.store_id) {
    io.to(`store:${payment.notes.store_id}`).emit('payment_failed', {
      orderId: payment.order_id,
      reason:  payment.error_description,
    });
  }
}

async function handleSubscriptionCharged(sub) {
  await db.query(
    `UPDATE subscriptions SET
       status='active', failed_payments=0, updated_at=NOW()
     WHERE gateway_sub_id=$1`,
    [sub.id]
  );
}

async function handleSubscriptionHalted(sub) {
  await db.query(
    `UPDATE subscriptions SET
       status='past_due',
       failed_payments = failed_payments + 1,
       updated_at=NOW()
     WHERE gateway_sub_id=$1`,
    [sub.id]
  );
  // After 3 failures, downgrade to bronze
  const subRes = await db.query(
    `SELECT store_id, failed_payments FROM subscriptions WHERE gateway_sub_id=$1`,
    [sub.id]
  );
  if (subRes.rows[0]?.failed_payments >= 3) {
    await db.query(
      `UPDATE stores SET subscription_tier='bronze' WHERE id=$1`,
      [subRes.rows[0].store_id]
    );
  }
}

// ─────────────────────────────────────────────
// RECORD CASH PAYMENT (no gateway)
// ─────────────────────────────────────────────

async function recordCashPayment(storeId, saleId, amount, cashierId) {
  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO payments (sale_id,store_id,method,amount,status,paid_at)
       VALUES ($1,$2,'cash',$3,'paid',NOW())`,
      [saleId, storeId, amount]
    );
    await client.query(
      `UPDATE sales SET payment_status='paid' WHERE id=$1 AND store_id=$2`,
      [saleId, storeId]
    );
    // Update shift cash sales
    await client.query(
      `UPDATE shifts SET cash_sales=cash_sales+$2
       WHERE id=(SELECT shift_id FROM sales WHERE id=$1)`,
      [saleId, amount]
    );
  });

  // Emit confirmation to POS (triggers receipt print)
  const io = getIO();
  if (io) {
    const saleRes = await db.query(
      `SELECT invoice_number FROM sales WHERE id=$1`, [saleId]
    );
    io.to(`store:${storeId}`).emit('payment_confirmed', {
      saleId, amount, method: 'cash',
      invoiceNumber: saleRes.rows[0]?.invoice_number,
      timestamp: new Date().toISOString(),
    });
  }

  return { paid: true, method: 'cash', amount };
}

module.exports = {
  generateUPIQR,
  createRazorpayOrder,
  handleRazorpayWebhook,
  recordCashPayment,
};
