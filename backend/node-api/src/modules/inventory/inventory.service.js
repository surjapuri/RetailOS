'use strict';
const { db }       = require('../../config/database');
const { getQueue } = require('../../config/queues');
const AppError     = require('../../utils/AppError');
const { cacheDel, KEYS } = require('../../config/redis');

async function addProduct(storeId, createdBy, data) {
  const { name, barcode, pluCode, basePrice, mrp, hsnCode, gstRate,
          unitType, isLoose, category, brand, imageUrl, lowStockAt } = data;
  const r = await db.query(
    `INSERT INTO products
       (store_id,name,barcode,plu_code,base_price,mrp,hsn_code,gst_rate,
        unit_type,is_loose,category,brand,image_url,low_stock_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [storeId, name, barcode || null, pluCode || null, basePrice, mrp || null,
     hsnCode || null, gstRate || 0, unitType || 'piece', isLoose || false,
     category || null, brand || null, imageUrl || null, lowStockAt || 0, createdBy]);
  return r.rows[0];
}

async function updateProductPrice(storeId, productId, newPrice, updatedBy) {
  const r = await db.query(
    `UPDATE products SET base_price=$1,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *`,
    [newPrice, productId, storeId]);
  if (!r.rows[0]) throw new AppError('Product not found', 404);
  await cacheDel(KEYS.product(storeId, productId));
  await cacheDel(KEYS.volRules(storeId));
  return r.rows[0];
}

async function receiveStock(storeId, poId, batches) {
  return db.transaction(async (client) => {
    const results = [];
    for (const batch of batches) {
      const { productId, qty, purchasePrice, mfgDate, expiryDate, supplierId, batchNumber } = batch;
      const r = await client.query(
        `INSERT INTO inventory_batches
           (product_id,store_id,po_id,batch_number,qty_received,qty_remaining,
            purchase_price,mfg_date,expiry_date,supplier_id)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) RETURNING *`,
        [productId, storeId, poId || null, batchNumber || null, qty,
         purchasePrice || null, mfgDate || null, expiryDate || null, supplierId || null]);
      await client.query(
        `UPDATE products SET stock_qty=stock_qty+$1,updated_at=NOW() WHERE id=$2`,
        [qty, productId]);
      await cacheDel(KEYS.product(storeId, productId));
      results.push(r.rows[0]);
    }
    return results;
  });
}

async function getExpiryAlerts(storeId, withinDays) {
  withinDays = withinDays || 30;
  const r = await db.query(
    `SELECT ib.*, p.name AS product_name, p.barcode,
       EXTRACT(DAY FROM ib.expiry_date - CURRENT_DATE) AS days_to_expiry
     FROM inventory_batches ib JOIN products p ON p.id=ib.product_id
     WHERE ib.store_id=$1 AND ib.qty_remaining > 0 AND ib.expiry_date IS NOT NULL
       AND ib.expiry_date <= CURRENT_DATE + INTERVAL '1 day' * $2
     ORDER BY ib.expiry_date ASC`,
    [storeId, withinDays]);
  return r.rows;
}

async function getLowStockAlerts(storeId) {
  const r = await db.query(
    `SELECT p.*, p.stock_qty - p.low_stock_at AS stock_deficit
     FROM products p
     WHERE p.store_id=$1 AND p.is_active=TRUE AND p.stock_qty <= p.low_stock_at AND p.low_stock_at > 0
     ORDER BY (p.stock_qty / NULLIF(p.low_stock_at,0)) ASC`,
    [storeId]);
  return r.rows;
}

async function getStockSummary(storeId, page, limit) {
  page = page || 1; limit = limit || 50;
  const offset = (page-1)*limit;
  const r = await db.query(
    `SELECT p.*, COALESCE(MIN(ib.expiry_date),NULL) AS nearest_expiry,
            COUNT(ib.id) AS batch_count
     FROM products p
     LEFT JOIN inventory_batches ib ON ib.product_id=p.id AND ib.qty_remaining>0
     WHERE p.store_id=$1 AND p.is_active=TRUE
     GROUP BY p.id ORDER BY p.name LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]);
  return r.rows;
}

async function generateCustomBarcode(storeId, productId) {
  // EAN-13: store_prefix(7) + sequential(5) + checksum(1)
  const prefixRes = await db.query(`SELECT ean_prefix FROM stores WHERE id=$1`, [storeId]);
  const prefix    = prefixRes.rows[0]?.ean_prefix || '9999999';
  const seqRes    = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(internal_barcode,8,5) AS INTEGER)),0)+1 AS next_seq
     FROM products WHERE store_id=$1 AND internal_barcode IS NOT NULL`,
    [storeId]);
  const seq = String(seqRes.rows[0].next_seq).padStart(5,'0');
  const partial = `${prefix}${seq}`;

  // EAN-13 checksum
  let sum = 0;
  for (let i = 0; i < 12; i++) { sum += parseInt(partial[i]) * (i % 2 === 0 ? 1 : 3); }
  const checksum = (10 - (sum % 10)) % 10;
  const ean13 = `${partial}${checksum}`;

  await db.query(`UPDATE products SET internal_barcode=$1 WHERE id=$2 AND store_id=$3`, [ean13, productId, storeId]);
  return { ean13 };
}

module.exports = { addProduct, updateProductPrice, receiveStock, getExpiryAlerts, getLowStockAlerts, getStockSummary, generateCustomBarcode };
