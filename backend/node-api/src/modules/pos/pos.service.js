'use strict';

const { db }   = require('../../config/database');
const { redis, KEYS, TTL, cacheGet, cacheSet, cacheDel } = require('../../config/redis');
const AppError = require('../../utils/AppError');
const logger   = require('../../utils/logger');

// ─────────────────────────────────────────────
// PRODUCT LOOKUP (PLU or Barcode or text)
// ─────────────────────────────────────────────

async function lookupProduct(storeId, { barcode, pluCode, query }) {
  let sql, params;
  if (barcode) {
    sql    = `SELECT * FROM products WHERE (barcode=$1 OR internal_barcode=$1) AND store_id=$2 AND is_active=TRUE`;
    params = [barcode, storeId];
  } else if (pluCode) {
    sql    = `SELECT * FROM products WHERE plu_code=$1 AND store_id=$2 AND is_active=TRUE`;
    params = [pluCode, storeId];
  } else if (query) {
    sql    = `SELECT * FROM products WHERE store_id=$1 AND is_active=TRUE AND name ILIKE $2 ORDER BY name LIMIT 10`;
    params = [storeId, `%${query}%`];
  } else {
    throw new AppError('Provide barcode, pluCode, or query', 400);
  }
  const result = await db.query(sql, params, storeId);
  if (!result.rows.length) throw new AppError('Product not found', 404);
  return (barcode || pluCode) ? result.rows[0] : result.rows;
}

// ─────────────────────────────────────────────
// VOLUME DISCOUNT ENGINE (server-side, cached)
// ─────────────────────────────────────────────

async function evaluateVolumeDiscount(storeId, productId, quantity) {
  const cacheKey = KEYS.volRules(storeId);
  let   allRules = await cacheGet(cacheKey);

  if (!allRules) {
    const result = await db.query(
      `SELECT vdr.* FROM volume_discount_rules vdr
       WHERE vdr.store_id=$1 AND vdr.is_active=TRUE
         AND (vdr.valid_from IS NULL OR vdr.valid_from<=CURRENT_DATE)
         AND (vdr.valid_to   IS NULL OR vdr.valid_to  >=CURRENT_DATE)`,
      [storeId]
    );
    allRules = result.rows;
    await cacheSet(cacheKey, allRules, TTL.VOLUME_RULES);
  }

  const applicable = allRules
    .filter(r => r.product_id === productId && parseFloat(r.min_qty) <= quantity)
    .sort((a, b) => parseFloat(b.min_qty) - parseFloat(a.min_qty));

  if (!applicable.length) return { ruleApplied: false, ruleId: null, effectivePrice: null };

  const best = applicable[0];
  return {
    ruleApplied:    true,
    ruleId:         best.id,
    effectivePrice: parseFloat(best.effective_price),
    label:          best.label,
  };
}

// ─────────────────────────────────────────────
// GST CALCULATION
// ─────────────────────────────────────────────

function calculateGST({ lineTotal, gstRate, isInterState = false }) {
  if (!gstRate || gstRate === 0)
    return { taxableAmount: lineTotal, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };

  const taxable  = parseFloat((lineTotal / (1 + gstRate / 100)).toFixed(2));
  const tax      = parseFloat((lineTotal - taxable).toFixed(2));

  if (isInterState) return { taxableAmount: taxable, cgst: 0, sgst: 0, igst: tax, totalTax: tax };
  const half = parseFloat((tax / 2).toFixed(2));
  return { taxableAmount: taxable, cgst: half, sgst: half, igst: 0, totalTax: tax };
}

// ─────────────────────────────────────────────
// BUILD LINE ITEM (server-authoritative price)
// ─────────────────────────────────────────────

async function buildLineItem(storeId, { productId, quantity }) {
  const prodKey = KEYS.product(storeId, productId);
  let   product = await cacheGet(prodKey);

  if (!product) {
    const r = await db.query(
      `SELECT id, name, barcode, hsn_code, base_price, gst_rate, unit_type, is_loose, stock_qty
       FROM products WHERE id=$1 AND store_id=$2 AND is_active=TRUE`,
      [productId, storeId]
    );
    if (!r.rows[0]) throw new AppError(`Product ${productId} not found`, 404);
    product = r.rows[0];
    await cacheSet(prodKey, product, TTL.PRODUCT_CATALOG);
  }

  const qty          = parseFloat(quantity);
  const disc         = await evaluateVolumeDiscount(storeId, productId, qty);
  const basePriceSnap = parseFloat(product.base_price);
  const effectivePrice = disc.ruleApplied ? disc.effectivePrice : basePriceSnap;
  const lineTotal    = parseFloat((effectivePrice * qty).toFixed(2));
  const gstCalc      = calculateGST({ lineTotal, gstRate: parseFloat(product.gst_rate) });

  return {
    product_id: product.id, product_name: product.name,
    product_barcode: product.barcode, hsn_code: product.hsn_code,
    quantity: qty, unit_type: product.unit_type,
    base_price_snapshot: basePriceSnap, effective_price: effectivePrice,
    applied_rule_id: disc.ruleId || null,
    gst_rate: parseFloat(product.gst_rate), gst_amount: gstCalc.totalTax,
    line_total: lineTotal, taxable_amount: gstCalc.taxableAmount,
    cgst: gstCalc.cgst, sgst: gstCalc.sgst,
    discount_applied: disc.ruleApplied, discount_label: disc.label || null,
  };
}

// ─────────────────────────────────────────────
// CREATE BILL
// ─────────────────────────────────────────────

async function createBill(storeId, branchId, cashierId, shiftId, billData) {
  const { items, customerId, discountAmount = 0, discountReason,
          discountApprovedBy, isGstBill = false, buyerGstin,
          deviceId, offlineAt } = billData;

  if (!items?.length) throw new AppError('Bill must have at least one item', 400);

  return db.transaction(async (client) => {
    const lineItems = [];
    let subtotal = 0, cgstTotal = 0, sgstTotal = 0, taxable = 0;

    for (const item of items) {
      const li = await buildLineItem(storeId, { productId: item.product_id, quantity: item.quantity });
      lineItems.push(li);
      subtotal  += li.line_total;
      cgstTotal += li.cgst;
      sgstTotal += li.sgst;
      taxable   += li.taxable_amount;
    }

    subtotal = parseFloat(subtotal.toFixed(2));
    const discAmt  = parseFloat(parseFloat(discountAmount).toFixed(2));
    const totalAmt = parseFloat(Math.max(0, subtotal - discAmt).toFixed(2));

    const invResult = await client.query(
      `SELECT generate_invoice_number($1) AS invoice_number`, [storeId]
    );
    const invoiceNumber = invResult.rows[0].invoice_number;

    const saleResult = await client.query(
      `INSERT INTO sales (
         invoice_number, store_id, branch_id, cashier_id, shift_id, customer_id,
         subtotal, discount_amount, taxable_amount, cgst_amount, sgst_amount,
         total_amount, is_gst_bill, buyer_gstin, discount_reason, discount_approved_by,
         device_id, offline_at, billed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,NOW()))
       RETURNING *`,
      [
        invoiceNumber, storeId, branchId, cashierId, shiftId, customerId || null,
        subtotal, discAmt, parseFloat(taxable.toFixed(2)),
        parseFloat(cgstTotal.toFixed(2)), parseFloat(sgstTotal.toFixed(2)),
        totalAmt, isGstBill, buyerGstin || null, discountReason || null,
        discountApprovedBy || null, deviceId || null, offlineAt || null, offlineAt,
      ]
    );
    const sale = saleResult.rows[0];

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id,product_id,product_name,product_barcode,hsn_code,
           quantity,unit_type,base_price_snapshot,effective_price,applied_rule_id,
           gst_rate,gst_amount,line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [sale.id, li.product_id, li.product_name, li.product_barcode, li.hsn_code,
         li.quantity, li.unit_type, li.base_price_snapshot, li.effective_price,
         li.applied_rule_id, li.gst_rate, li.gst_amount, li.line_total]
      );
      // FIFO stock deduction
      await deductStockFIFO(client, li.product_id, storeId, li.quantity);
    }

    if (shiftId) {
      await client.query(
        `UPDATE shifts SET total_sales=total_sales+$1 WHERE id=$2`, [totalAmt, shiftId]
      );
    }

    return { sale, lineItems, invoiceNumber };
  }, storeId);
}

// ─────────────────────────────────────────────
// FIFO STOCK DEDUCTION
// ─────────────────────────────────────────────

async function deductStockFIFO(client, productId, storeId, quantity) {
  let rem = parseFloat(quantity);
  const batches = await client.query(
    `SELECT id, qty_remaining FROM inventory_batches
     WHERE product_id=$1 AND store_id=$2 AND qty_remaining>0
     ORDER BY received_at ASC`,
    [productId, storeId]
  );
  for (const b of batches.rows) {
    if (rem <= 0) break;
    const deduct = Math.min(rem, parseFloat(b.qty_remaining));
    await client.query(
      `UPDATE inventory_batches SET qty_remaining=qty_remaining-$1 WHERE id=$2`,
      [deduct, b.id]
    );
    rem -= deduct;
  }
  await client.query(
    `UPDATE products SET stock_qty=stock_qty-$1, updated_at=NOW() WHERE id=$2`,
    [quantity, productId]
  );
  await cacheDel(KEYS.product(storeId, productId));
}

// ─────────────────────────────────────────────
// VOID BILL
// ─────────────────────────────────────────────

async function voidBill(storeId, saleId, cashierId, supervisorSessionId, reason) {
  return db.transaction(async (client) => {
    const sessRes = await client.query(
      `SELECT s.*, u.store_id AS sup_store_id
       FROM supervisor_sessions s JOIN users u ON u.id=s.supervisor_id
       WHERE s.id=$1 AND s.used=FALSE AND s.expires_at>NOW()`,
      [supervisorSessionId]
    );
    if (!sessRes.rows[0]) throw new AppError('Invalid or expired supervisor session', 403);
    const sess = sessRes.rows[0];
    if (sess.sup_store_id !== storeId) throw new AppError('Supervisor store mismatch', 403);

    await client.query(`UPDATE supervisor_sessions SET used=TRUE,used_at=NOW() WHERE id=$1`, [supervisorSessionId]);

    const saleRes = await client.query(
      `SELECT s.*, json_agg(si) AS items FROM sales s
       LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE s.id=$1 AND s.store_id=$2 AND s.bill_type='sale' GROUP BY s.id`,
      [saleId, storeId]
    );
    if (!saleRes.rows[0]) throw new AppError('Sale not found', 404);
    const sale = saleRes.rows[0];
    if (sale.payment_status === 'paid') throw new AppError('Cannot void a paid bill. Process a return.', 400);

    await client.query(`UPDATE sales SET bill_type='void' WHERE id=$1`, [saleId]);

    for (const item of sale.items || []) {
      if (item?.product_id) {
        await client.query(`UPDATE products SET stock_qty=stock_qty+$1 WHERE id=$2`, [item.quantity, item.product_id]);
        await cacheDel(KEYS.product(storeId, item.product_id));
      }
    }

    await client.query(
      `INSERT INTO void_audit_log (original_sale_id,store_id,branch_id,cashier_id,supervisor_id,auth_method_used,void_reason,void_amount,voided_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [saleId, storeId, sale.branch_id, cashierId, sess.supervisor_id, sess.auth_method, reason, sale.total_amount, JSON.stringify(sale.items || [])]
    );

    if (sale.shift_id) {
      await client.query(`UPDATE shifts SET total_voids=total_voids+$1 WHERE id=$2`, [sale.total_amount, sale.shift_id]);
    }

    return { voided: true, saleId, invoiceNumber: sale.invoice_number };
  }, storeId);
}

// ─────────────────────────────────────────────
// SHIFT MANAGEMENT
// ─────────────────────────────────────────────

async function openShift(branchId, cashierId, terminalId, openingCash) {
  const existing = await db.query(
    `SELECT id FROM shifts WHERE branch_id=$1 AND cashier_id=$2 AND status='open'`,
    [branchId, cashierId]
  );
  if (existing.rows[0]) throw new AppError('Open shift already exists for this cashier', 400);
  const r = await db.query(
    `INSERT INTO shifts (branch_id,cashier_id,terminal_id,opening_cash) VALUES ($1,$2,$3,$4) RETURNING *`,
    [branchId, cashierId, terminalId, openingCash]
  );
  return r.rows[0];
}

async function closeShift(shiftId, cashierId, closingCash) {
  return db.transaction(async (client) => {
    const r = await client.query(
      `SELECT s.*, COALESCE(SUM(p.amount) FILTER (WHERE p.method='cash'),0) AS cash_sales_sum
       FROM shifts s
       LEFT JOIN sales sl ON sl.shift_id=s.id AND sl.bill_type='sale'
       LEFT JOIN payments p ON p.sale_id=sl.id AND p.status='paid' AND p.method='cash'
       WHERE s.id=$1 AND s.cashier_id=$2 AND s.status='open' GROUP BY s.id`,
      [shiftId, cashierId]
    );
    if (!r.rows[0]) throw new AppError('Shift not found or already closed', 404);
    const shift    = r.rows[0];
    const expected = parseFloat((parseFloat(shift.opening_cash) + parseFloat(shift.cash_sales_sum)).toFixed(2));
    const actual   = parseFloat(parseFloat(closingCash).toFixed(2));
    const variance = parseFloat((actual - expected).toFixed(2));

    await client.query(
      `UPDATE shifts SET closing_cash=$1,expected_cash=$2,cash_variance=$3,status='closed',ended_at=NOW() WHERE id=$4`,
      [actual, expected, variance, shiftId]
    );
    if (Math.abs(variance) > 200) logger.warn(`Shift ${shiftId} cash variance ₹${variance}`);
    return { shiftId, openingCash: shift.opening_cash, closingCash: actual, expectedCash: expected, variance };
  });
}

// ─────────────────────────────────────────────
// OFFLINE SYNC BATCH
// ─────────────────────────────────────────────

async function syncOfflineBatch(storeId, branchId, deviceId, bills) {
  const results = { synced: [], failed: [], duplicates: [] };
  for (const bill of bills) {
    try {
      const existing = await db.query(`SELECT id FROM pending_sync_queue WHERE id=$1`, [bill.offlineId]);
      if (existing.rows[0]) { results.duplicates.push(bill.offlineId); continue; }
      await db.query(
        `INSERT INTO pending_sync_queue (id,store_id,branch_id,device_id,payload,sync_status,created_offline_at)
         VALUES ($1,$2,$3,$4,$5,'synced',$6)`,
        [bill.offlineId, storeId, branchId, deviceId, JSON.stringify(bill), bill.offlineAt]
      );
      const result = await createBill(storeId, branchId, bill.cashierId, bill.shiftId, { ...bill, deviceId, offlineAt: bill.offlineAt });
      results.synced.push({ offlineId: bill.offlineId, saleId: result.sale.id });
    } catch (err) {
      logger.error(`Sync failed for ${bill.offlineId}:`, err.message);
      results.failed.push({ offlineId: bill.offlineId, error: err.message });
    }
  }
  return results;
}

module.exports = { lookupProduct, evaluateVolumeDiscount, calculateGST, buildLineItem, createBill, voidBill, openShift, closeShift, syncOfflineBatch };
