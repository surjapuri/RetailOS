'use strict';
const { db }    = require('../../config/database');
const { cacheGet, cacheSet, deductAdBudget, getRemainingAdBudget, TTL, KEYS } = require('../../config/redis');
const { getQueue } = require('../../config/queues');
const AppError  = require('../../utils/AppError');

async function createCampaign(storeId, tierConfig, data) {
  if (!tierConfig.can_run_ads) throw new AppError('Ad campaigns require Silver or Gold tier', 402);
  const { campaignName, campaignType, placement, targetLat, targetLng, targetRadiusKm,
          dailyBudget, bidAmount, bidType, headline, description, imageUrl, ctaText, ctaUrl,
          startsAt, endsAt } = data;

  const rateKey = KEYS.adRates(placement);
  let rates = await cacheGet(rateKey);
  if (!rates) {
    const r = await db.query(`SELECT * FROM ad_rate_config WHERE placement=$1`, [placement]);
    rates = r.rows[0];
    if (!rates) throw new AppError('Invalid ad placement', 400);
    await cacheSet(rateKey, rates, TTL.AD_RATES);
  }

  const floorRate = bidType === 'cpc' ? parseFloat(rates.floor_cpc) : parseFloat(rates.floor_cpm);
  if (bidAmount < floorRate) throw new AppError(`Minimum bid is Rs.${floorRate}`, 400);
  if (dailyBudget < 100)    throw new AppError('Minimum daily budget is Rs.100', 400);

  const r = await db.query(
    `INSERT INTO ad_campaigns
       (store_id,campaign_name,campaign_type,placement,target_lat,target_lng,target_radius_km,
        daily_budget,bid_amount,bid_type,headline,description,image_url,cta_text,cta_url,starts_at,ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [storeId, campaignName, campaignType, placement, targetLat || null, targetLng || null,
     targetRadiusKm || 5, dailyBudget, bidAmount, bidType || 'cpc', headline,
     description || null, imageUrl || null, ctaText || null, ctaUrl || null, startsAt, endsAt || null]);
  return r.rows[0];
}

async function runAdAuction(placement, viewerLat, viewerLng, viewerType) {
  const r = await db.query(
    `SELECT ac.*, s.business_name, s.logo_url
     FROM ad_campaigns ac JOIN stores s ON s.id=ac.store_id
     WHERE ac.status='active' AND ac.placement=$1
       AND (ac.ends_at IS NULL OR ac.ends_at >= CURRENT_DATE)
       AND ac.starts_at <= CURRENT_DATE
       AND (viewerType=$4 OR TRUE)
     ORDER BY (ac.bid_amount * ac.quality_score) DESC LIMIT 5`,
    [placement, viewerLat, viewerLng, viewerType]);

  for (const campaign of r.rows) {
    const remaining = await getRemainingAdBudget(campaign.id, parseFloat(campaign.daily_budget));
    if (remaining >= parseFloat(campaign.bid_amount)) {
      return campaign; // Winner
    }
  }
  return null;
}

async function recordAdEvent(campaignId, eventType, viewerType, viewerId, lat, lng, charge) {
  await db.query(
    `INSERT INTO ad_events (campaign_id,event_type,viewer_type,viewer_id,lat,lng,charge)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [campaignId, eventType, viewerType, viewerId || null, lat || null, lng || null, charge]);
  if (charge > 0) {
    const newBudget = await deductAdBudget(campaignId, charge);
    await db.query(
      `UPDATE ad_campaigns SET ${eventType === 'click' ? 'clicks' : 'impressions'}=${eventType === 'click' ? 'clicks' : 'impressions'}+1, spend_to_date=spend_to_date+$1 WHERE id=$2`,
      [charge, campaignId]);
    if (newBudget <= 0) {
      await db.query(`UPDATE ad_campaigns SET status='budget_exhausted' WHERE id=$1`, [campaignId]);
    }
  }
}

async function updateQualityScore(campaignId) {
  const r = await db.query(
    `SELECT clicks::float/NULLIF(impressions,0) AS ctr, impressions
     FROM ad_campaigns WHERE id=$1`,
    [campaignId]);
  if (!r.rows[0]) return;
  const ctr          = parseFloat(r.rows[0].ctr || 0);
  const relevance    = 0.8; // Placeholder — extend with category matching
  const qualityScore = parseFloat((ctr * 0.6 + relevance * 0.4).toFixed(4)) || 1.0;
  await db.query(`UPDATE ad_campaigns SET quality_score=$1 WHERE id=$2`, [qualityScore, campaignId]);
}

async function getCampaignStats(storeId, campaignId) {
  const r = await db.query(
    `SELECT ac.*,
       CASE WHEN impressions > 0 THEN ROUND(clicks::numeric/impressions*100,2) ELSE 0 END AS ctr_pct
     FROM ad_campaigns ac WHERE ac.id=$1 AND ac.store_id=$2`,
    [campaignId, storeId]);
  if (!r.rows[0]) throw new AppError('Campaign not found', 404);
  return r.rows[0];
}

module.exports = { createCampaign, runAdAuction, recordAdEvent, updateQualityScore, getCampaignStats };
