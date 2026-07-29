'use strict';
const { db }   = require('../../config/database');
const { cacheDel, cacheSet, KEYS, TTL } = require('../../config/redis');
const AppError = require('../../utils/AppError');
const bcrypt   = require('bcrypt');
const { totp } = require('otplib');

async function getDashboard() {
  const [stores, revenue, tickets] = await Promise.all([
    db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE kyb_status='verified') AS verified,
              COUNT(*) FILTER (WHERE is_suspended) AS suspended FROM stores`),
    db.query(`SELECT SUM(amount_paid) AS mrr FROM subscriptions WHERE status='active'
              AND current_period_start >= DATE_TRUNC('month', NOW())`),
    db.query(`SELECT COUNT(*) AS open, COUNT(*) FILTER (WHERE status='escalated') AS escalated
              FROM grievance_tickets WHERE status NOT IN ('resolved','closed')`),
  ]);
  return {
    stores:  stores.rows[0],
    revenue: revenue.rows[0],
    tickets: tickets.rows[0],
  };
}

async function updateTierConfig(superAdminId, tier, updates) {
  const { crm_limit, inbox_msg_limit, wa_msg_limit, branch_limit, monthly_price,
          can_run_ads, can_use_b2b, can_use_ai_nudge } = updates;
  const r = await db.query(
    `UPDATE tier_config SET
       crm_limit=COALESCE($2,crm_limit), inbox_msg_limit=COALESCE($3,inbox_msg_limit),
       wa_msg_limit=COALESCE($4,wa_msg_limit), branch_limit=COALESCE($5,branch_limit),
       monthly_price=COALESCE($6,monthly_price), can_run_ads=COALESCE($7,can_run_ads),
       can_use_b2b=COALESCE($8,can_use_b2b), can_use_ai_nudge=COALESCE($9,can_use_ai_nudge),
       updated_by=$10, updated_at=NOW()
     WHERE tier=$1 RETURNING *`,
    [tier, crm_limit, inbox_msg_limit, wa_msg_limit, branch_limit, monthly_price,
     can_run_ads, can_use_b2b, can_use_ai_nudge, superAdminId]);
  if (!r.rows[0]) throw new AppError('Invalid tier', 404);
  await cacheDel(KEYS.tierConfig(tier));
  return r.rows[0];
}

async function updateAdRates(superAdminId, placement, updates) {
  const r = await db.query(
    `UPDATE ad_rate_config SET
       floor_cpc=COALESCE($2,floor_cpc), floor_cpm=COALESCE($3,floor_cpm),
       updated_by=$4, updated_at=NOW()
     WHERE placement=$1 RETURNING *`,
    [placement, updates.floor_cpc || null, updates.floor_cpm || null, superAdminId]);
  if (!r.rows[0]) throw new AppError('Invalid placement', 404);
  await cacheDel(KEYS.adRates(placement));
  return r.rows[0];
}

async function approveAdCampaign(superAdminId, campaignId) {
  const r = await db.query(
    `UPDATE ad_campaigns SET status='active', approved_by=$1, approved_at=NOW()
     WHERE id=$2 AND status='pending_approval' RETURNING *`,
    [superAdminId, campaignId]);
  if (!r.rows[0]) throw new AppError('Campaign not found or already processed', 404);
  await _logPlatformAction(superAdminId, 'ad_approve', 'campaign', campaignId, {});
  return r.rows[0];
}

async function rejectAdCampaign(superAdminId, campaignId, reason) {
  const r = await db.query(
    `UPDATE ad_campaigns SET status='rejected', approved_by=$1, rejection_reason=$3
     WHERE id=$2 RETURNING *`,
    [superAdminId, campaignId, reason]);
  if (!r.rows[0]) throw new AppError('Campaign not found', 404);
  await _logPlatformAction(superAdminId, 'ad_reject', 'campaign', campaignId, { reason });
  return r.rows[0];
}

async function suspendStore(superAdminId, storeId, ticketId, reason, days) {
  const suspendedUntil = days ? new Date(Date.now() + days * 86400_000) : null;
  return db.transaction(async (client) => {
    await client.query(
      `UPDATE stores SET is_suspended=TRUE, suspension_reason=$1, suspended_until=$2 WHERE id=$3`,
      [reason, suspendedUntil, storeId]);
    const logR = await client.query(
      `INSERT INTO platform_actions_log
         (super_admin_id,action_type,target_type,target_id,ticket_id,reason,suspension_days,meta)
       VALUES ($1,'suspend','store',$2,$3,$4,$5,$6) RETURNING id`,
      [superAdminId, storeId, ticketId || null, reason, days || null, JSON.stringify({ suspendedUntil })]);
    await client.query(
      `INSERT INTO store_suspensions (store_id,reason,suspension_type,suspended_until,action_log_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [storeId, reason, days ? 'temporary' : 'permanent', suspendedUntil, logR.rows[0].id]);
  });
}

async function issuePlatformCredit(superAdminId, customerId, ticketId, amount) {
  return db.transaction(async (client) => {
    await client.query(
      `UPDATE customers SET platform_credit=platform_credit+$1 WHERE id=$2`,
      [amount, customerId]);
    await client.query(
      `INSERT INTO loyalty_transactions (customer_id,store_id,type,points,description)
       SELECT $1, store_id,'platform_credit',0,'Platform credit Rs.'||$2
       FROM customers WHERE id=$1 LIMIT 1`,
      [customerId, amount]);
    await _logPlatformAction(superAdminId, 'platform_credit', 'customer', customerId,
      { amount }, ticketId);
    const { sendInboxMessage } = require('../crm/crm.service');
    const custRes = await client.query(`SELECT store_id FROM customers WHERE id=$1`, [customerId]);
    await sendInboxMessage(customerId, custRes.rows[0].store_id, {
      msg_type: 'platform_credit',
      title:    `RetailOS Platform Credit: Rs.${amount}`,
      body:     `We've issued Rs.${amount} platform credit to your account. Valid at all RetailOS stores.`,
      metadata: { credit: amount },
    });
  });
}

async function getEscalatedTickets(page, limit, severity) {
  page = page || 1; limit = limit || 20;
  const offset = (page-1)*limit;
  const params = [limit, offset];
  let where = severity ? ` AND severity=$3` : '';
  if (severity) params.push(severity);
  const r = await db.query(
    `SELECT gt.*, s.business_name AS respondent_name
     FROM grievance_tickets gt
     LEFT JOIN stores s ON s.id=gt.respondent_id::uuid
     WHERE gt.status IN ('open','escalated')
     ${where}
     ORDER BY gt.severity DESC, gt.sla_deadline ASC
     LIMIT $1 OFFSET $2`,
    params);
  return r.rows;
}

async function _logPlatformAction(superAdminId, actionType, targetType, targetId, meta, ticketId) {
  await db.query(
    `INSERT INTO platform_actions_log (super_admin_id,action_type,target_type,target_id,ticket_id,meta)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [superAdminId, actionType, targetType, targetId, ticketId || null, JSON.stringify(meta)]);
}

module.exports = { getDashboard, updateTierConfig, updateAdRates, approveAdCampaign,
                   rejectAdCampaign, suspendStore, issuePlatformCredit, getEscalatedTickets };
