'use strict';
const { db }   = require('../../config/database');
const { cacheGetOrSet, cacheSet, KEYS, TTL } = require('../../config/redis');

async function discoverStores(lat, lng, radiusKm, mode) {
  radiusKm = Math.min(radiusKm || 5, 20);
  const cacheKey = `geo:${parseFloat(lat).toFixed(3)}:${parseFloat(lng).toFixed(3)}:${mode}`;

  return cacheGetOrSet(cacheKey, TTL.GEO_DISCOVERY, async () => {
    const storeType = mode === 'b2b' ? `AND s.store_type='wholesale'` : `AND s.store_type != 'wholesale'`;
    const r = await db.query(
      `SELECT s.id, s.business_name, s.logo_url, s.store_type,
              b.id AS branch_id, b.name AS branch_name, b.address,
              b.operating_hours, b.delivery_radius_km,
              ST_Distance(b.location::geography, ST_SetSRID(ST_Point($2,$1),4326)::geography)/1000 AS dist_km,
              ts.trust_score, ts.avg_rating, ts.total_ratings,
              ts.score_status,
              COALESCE(ac.is_boosted, FALSE) AS is_boosted,
              COALESCE(ac.boost_score, 0) AS boost_score,
              -- Composite rank: 40% distance, 35% trust, 25% ad boost
              (0.40 * (1.0 / GREATEST(ST_Distance(b.location::geography,
                ST_SetSRID(ST_Point($2,$1),4326)::geography)/1000, 0.1)))
              + (0.35 * COALESCE(ts.trust_score,3.0)/5.0)
              + (0.25 * COALESCE(ac.boost_score,0)) AS composite_rank
       FROM stores s
       JOIN branches b ON b.store_id=s.id AND b.is_active=TRUE
       LEFT JOIN store_trust_scores ts ON ts.store_id=s.id
       LEFT JOIN (
         SELECT store_id, TRUE AS is_boosted, 1.0 AS boost_score
         FROM ad_campaigns
         WHERE status='active' AND campaign_type='b2c_retail' AND placement='map_top'
           AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)
       ) ac ON ac.store_id=s.id
       WHERE s.is_discoverable=TRUE AND s.is_suspended=FALSE
         AND ts.score_status != 'suspended'
         ${storeType}
         AND ST_DWithin(
           b.location::geography,
           ST_SetSRID(ST_Point($2,$1),4326)::geography,
           $3 * 1000
         )
       ORDER BY composite_rank DESC, dist_km ASC
       LIMIT 30`,
      [lat, lng, radiusKm]);
    return r.rows;
  });
}

async function getNearbyOffers(lat, lng, radiusKm) {
  const r = await db.query(
    `SELECT so.*, s.business_name, s.logo_url,
            ST_Distance(b.location::geography, ST_SetSRID(ST_Point($2,$1),4326)::geography)/1000 AS dist_km
     FROM store_offers so
     JOIN branches b ON b.id=so.branch_id
     JOIN stores s ON s.id=so.store_id
     WHERE so.is_active=TRUE AND s.is_suspended=FALSE
       AND (so.ends_at IS NULL OR so.ends_at > NOW())
       AND ST_DWithin(b.location::geography, ST_SetSRID(ST_Point($2,$1),4326)::geography, $3*1000)
     ORDER BY so.is_boosted DESC, dist_km ASC LIMIT 20`,
    [lat, lng, radiusKm || 5]);
  return r.rows;
}

async function submitRating(storeId, customerId, saleId, rating, reviewText) {
  // Anti-gaming: check purchase time
  const saleRes = await db.query(
    `SELECT billed_at FROM sales WHERE id=$1 AND customer_id=$2 AND store_id=$3`,
    [saleId, customerId, storeId]);
  if (!saleRes.rows[0]) throw new Error('Sale not found or not yours');

  const minsSincePurchase = (Date.now() - new Date(saleRes.rows[0].billed_at).getTime()) / 60000;
  const isSuspicious      = minsSincePurchase < 5;

  const r = await db.query(
    `INSERT INTO store_ratings (store_id,customer_id,sale_id,rating,review_text,is_suspicious,purchase_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [storeId, customerId, saleId, rating, reviewText || null, isSuspicious, saleRes.rows[0].billed_at]);
  return r.rows[0];
}

async function getStoreProfile(storeId, branchId) {
  const [storeRes, offersRes, ratingsRes] = await Promise.all([
    db.query(
      `SELECT s.id, s.business_name, s.logo_url, s.store_type,
              b.name AS branch_name, b.address, b.operating_hours, b.delivery_radius_km, b.wa_catalog_id,
              ts.trust_score, ts.avg_rating, ts.total_ratings
       FROM stores s JOIN branches b ON b.id=$2
       LEFT JOIN store_trust_scores ts ON ts.store_id=s.id
       WHERE s.id=$1`,
      [storeId, branchId]),
    db.query(
      `SELECT * FROM store_offers WHERE branch_id=$1 AND is_active=TRUE
       AND (ends_at IS NULL OR ends_at > NOW()) ORDER BY is_boosted DESC LIMIT 10`,
      [branchId]),
    db.query(
      `SELECT rating, review_text, submitted_at FROM store_ratings
       WHERE store_id=$1 AND is_hidden=FALSE AND is_suspicious=FALSE
       ORDER BY submitted_at DESC LIMIT 5`,
      [storeId]),
  ]);
  return { ...storeRes.rows[0], offers: offersRes.rows, recent_ratings: ratingsRes.rows };
}

module.exports = { discoverStores, getNearbyOffers, submitRating, getStoreProfile };
