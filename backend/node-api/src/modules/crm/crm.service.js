'use strict';
const { db }       = require('../../config/database');
const { cacheGet, cacheSet, cacheDel, TTL, KEYS } = require('../../config/redis');
const { getQueue } = require('../../config/queues');
const AppError     = require('../../utils/AppError');

async function findOrCreateCustomer(storeId, mobile, name) {
  const r = await db.query(
    `SELECT id,name,mobile,khata_balance,dpdp_consent,preferred_channel,customer_tier,total_spend,visit_count
     FROM customers WHERE store_id=$1 AND mobile=$2`, [storeId, mobile]);
  if (r.rows[0]) return { customer: r.rows[0], isNew: false };
  const ins = await db.query(
    `INSERT INTO customers (store_id,mobile,name) VALUES ($1,$2,$3) RETURNING *`,
    [storeId, mobile, name || null]);
  return { customer: ins.rows[0], isNew: true };
}

async function recordConsent(customerId, action, cashierId, ip, deviceId) {
  const consentVal = action === 'consent_given' || action === 're_consent';
  await db.transaction(async (c) => {
    await c.query(`UPDATE customers SET dpdp_consent=$1,consent_given_at=NOW() WHERE id=$2`, [consentVal, customerId]);
    await c.query(
      `INSERT INTO dpdp_consent_log (customer_id,action,ip_address,device_id,cashier_id) VALUES ($1,$2,$3,$4,$5)`,
      [customerId, action, ip || null, deviceId || null, cashierId || null]);
  });
}

async function getPointsBalance(customerId, storeId) {
  const key    = KEYS.pointsBal(customerId, storeId);
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const r = await db.query(
    `SELECT COALESCE(SUM(points),0) AS balance FROM loyalty_transactions WHERE customer_id=$1 AND store_id=$2`,
    [customerId, storeId]);
  const bal = parseInt(r.rows[0].balance, 10);
  await cacheSet(key, bal, TTL.CUSTOMER_POINTS);
  return bal;
}

async function creditPoints(customerId, storeId, saleId, billAmount) {
  const ruleR = await db.query(`SELECT * FROM loyalty_rules WHERE store_id=$1 AND is_active=TRUE LIMIT 1`, [storeId]);
  if (!ruleR.rows[0]) return null;
  const rule = ruleR.rows[0];
  if (billAmount < parseFloat(rule.min_bill_for_earn)) return null;
  let pts = Math.floor(billAmount * parseFloat(rule.earn_per_rupee));
  const day = new Date().getDay();
  if ((day === 0 || day === 6) && parseFloat(rule.weekend_multiplier) > 1)
    pts = Math.floor(pts * parseFloat(rule.weekend_multiplier));
  if (pts <= 0) return null;
  await db.query(
    `INSERT INTO loyalty_transactions (customer_id,store_id,sale_id,type,points,description)
     VALUES ($1,$2,$3,'earn',$4,$5)`,
    [customerId, storeId, saleId, pts, `Earned on bill Rs.${billAmount}`]);
  await db.query(`UPDATE customers SET total_spend=total_spend+$1,visit_count=visit_count+1 WHERE id=$2`, [billAmount, customerId]);
  await cacheDel(KEYS.pointsBal(customerId, storeId));
  const newBal = await getPointsBalance(customerId, storeId);
  await sendInboxMessage(customerId, storeId, {
    msg_type: 'points', title: `You earned ${pts} points!`,
    body: `Your purchase of Rs.${billAmount} earned ${pts} points. Balance: ${newBal} pts.`,
    metadata: { points_earned: pts, points_balance: newBal },
  });
  return { pointsEarned: pts, newBalance: newBal };
}

async function redeemPoints(customerId, storeId, saleId, pointsToRedeem) {
  const bal  = await getPointsBalance(customerId, storeId);
  if (bal < pointsToRedeem) throw new AppError(`Insufficient points. Balance: ${bal}`, 400);
  const ruleR = await db.query(`SELECT * FROM loyalty_rules WHERE store_id=$1 AND is_active=TRUE LIMIT 1`, [storeId]);
  if (!ruleR.rows[0]) throw new AppError('Loyalty program not configured', 400);
  const rule = ruleR.rows[0];
  if (pointsToRedeem < rule.min_redeem_points) throw new AppError(`Minimum ${rule.min_redeem_points} pts to redeem`, 400);
  const discount = parseFloat((pointsToRedeem * parseFloat(rule.rupees_per_point)).toFixed(2));
  await db.query(
    `INSERT INTO loyalty_transactions (customer_id,store_id,sale_id,type,points,description)
     VALUES ($1,$2,$3,'redeem',$4,$5)`,
    [customerId, storeId, saleId, -pointsToRedeem, `Redeemed for Rs.${discount}`]);
  await cacheDel(KEYS.pointsBal(customerId, storeId));
  return { pointsRedeemed: pointsToRedeem, discountValue: discount };
}

async function sendInboxMessage(customerId, storeId, { msg_type, title, body: bodyText, action_url, metadata, channel_sent }) {
  const r = await db.query(
    `INSERT INTO customer_inbox (customer_id,store_id,msg_type,title,body,action_url,metadata,channel_sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [customerId, storeId, msg_type, title, bodyText, action_url || null,
     JSON.stringify(metadata || {}), JSON.stringify(channel_sent || ['inbox'])]);
  const custR = await db.query(`SELECT fcm_token,dpdp_consent,preferred_channel FROM customers WHERE id=$1`, [customerId]);
  const cust  = custR.rows[0];
  if (cust?.fcm_token && cust.dpdp_consent) {
    await getQueue('notifications').add('send-fcm', {
      token: cust.fcm_token, title, body: bodyText,
      data: { type: msg_type, inbox_id: r.rows[0].id, store_id: storeId },
    }, { attempts: 3 });
  }
  if (cust?.preferred_channel === 'whatsapp' && cust.dpdp_consent) {
    await getQueue('whatsapp').add('send-wa-message',
      { customerId, storeId, msg_type, title, body: bodyText, metadata }, { attempts: 3 });
  }
  return r.rows[0].id;
}

async function getCustomerInbox(customerId, storeId, page, limit) {
  page = page || 1; limit = limit || 20;
  const offset = (page-1)*limit;
  const [msgs, counts] = await Promise.all([
    db.query(
      `SELECT * FROM customer_inbox WHERE customer_id=$1 AND store_id=$2
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [customerId, storeId, limit, offset]),
    db.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_read=FALSE) AS unread
       FROM customer_inbox WHERE customer_id=$1 AND store_id=$2`,
      [customerId, storeId]),
  ]);
  await db.query(
    `UPDATE customer_inbox SET is_read=TRUE,read_at=NOW()
     WHERE customer_id=$1 AND store_id=$2 AND is_read=FALSE`,
    [customerId, storeId]);
  return { messages: msgs.rows, total: parseInt(counts.rows[0].total), unread: parseInt(counts.rows[0].unread), page, limit };
}

async function sendBroadcast(storeId, { title, body: bodyText, segment, scheduled_at }) {
  let segSQL = '';
  if (segment === 'khata')      segSQL = 'AND c.khata_balance > 0';
  if (segment === 'high_spend') segSQL = 'AND c.total_spend > 5000';
  if (segment === 'recent_30d') segSQL = `AND c.id IN (SELECT DISTINCT customer_id FROM sales WHERE store_id='${storeId}' AND billed_at>NOW()-INTERVAL '30 days' AND customer_id IS NOT NULL)`;
  const custR = await db.query(
    `SELECT id,fcm_token FROM customers WHERE store_id=$1 AND dpdp_consent=TRUE AND is_blocked=FALSE ${segSQL}`,
    [storeId]);
  const q = getQueue('broadcasts');
  const chunks = [];
  for (let i=0; i<custR.rows.length; i+=100) chunks.push(custR.rows.slice(i,i+100));
  for (const chunk of chunks) {
    await q.add('broadcast-chunk', { storeId, title, bodyText, customers: chunk },
      { delay: scheduled_at ? new Date(scheduled_at).getTime()-Date.now() : 0 });
  }
  return { queued: custR.rows.length, chunks: chunks.length };
}

async function getCustomerProfile(customerId, storeId) {
  const [profR, pts, salesR] = await Promise.all([
    db.query(`SELECT c.*,
        (SELECT COUNT(*) FROM sales WHERE customer_id=c.id AND bill_type='sale') AS total_visits,
        (SELECT MAX(billed_at) FROM sales WHERE customer_id=c.id) AS last_visit
       FROM customers c WHERE c.id=$1 AND c.store_id=$2`, [customerId, storeId]),
    getPointsBalance(customerId, storeId),
    db.query(`SELECT id,invoice_number,total_amount,billed_at,payment_status
       FROM sales WHERE customer_id=$1 AND bill_type='sale' ORDER BY billed_at DESC LIMIT 5`, [customerId]),
  ]);
  if (!profR.rows[0]) throw new AppError('Customer not found', 404);
  return { ...profR.rows[0], points_balance: pts, recent_sales: salesR.rows };
}

module.exports = { findOrCreateCustomer, recordConsent, getPointsBalance, creditPoints, redeemPoints,
                   sendInboxMessage, getCustomerInbox, sendBroadcast, getCustomerProfile };
