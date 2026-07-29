'use strict';
const { db } = require('../../config/database');
const { getQueue } = require('../../config/queues');
const AppError = require('../../utils/AppError');

async function getKhataBalance(customerId, storeId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END),0) AS balance
     FROM khata_transactions WHERE customer_id=$1 AND store_id=$2`,
    [customerId, storeId]);
  return parseFloat(r.rows[0].balance);
}

async function recordKhataPayment(customerId, storeId, amount, notes, collectedBy) {
  return db.transaction(async (client) => {
    const balance = await getKhataBalance(customerId, storeId);
    if (balance <= 0) throw new AppError('No outstanding Khata balance', 400);
    if (amount > balance) throw new AppError(`Payment exceeds outstanding balance of Rs.${balance}`, 400);
    const newBal = parseFloat((balance - amount).toFixed(2));
    await client.query(
      `INSERT INTO khata_transactions (customer_id,store_id,type,amount,balance_after,notes,collected_by)
       VALUES ($1,$2,'credit',$3,$4,$5,$6)`,
      [customerId, storeId, amount, newBal, notes || null, collectedBy]);
    await client.query(
      `UPDATE customers SET khata_balance=khata_balance-$1 WHERE id=$2`,
      [amount, customerId]);
    const { sendInboxMessage } = require('../crm/crm.service');
    await sendInboxMessage(customerId, storeId, {
      msg_type: 'khata', title: `Payment received: Rs.${amount}`,
      body: `Thank you! Rs.${amount} received. Remaining balance: Rs.${newBal}.`,
      metadata: { payment: amount, remaining: newBal },
    });
    return { paid: amount, remainingBalance: newBal };
  });
}

async function getKhataStatement(customerId, storeId, page, limit) {
  page = page || 1; limit = limit || 20;
  const offset = (page - 1) * limit;
  const txRes = await db.query(
    `SELECT kt.*, s.invoice_number FROM khata_transactions kt
     LEFT JOIN sales s ON s.id=kt.sale_id
     WHERE kt.customer_id=$1 AND kt.store_id=$2
     ORDER BY kt.created_at DESC LIMIT $3 OFFSET $4`,
    [customerId, storeId, limit, offset]);
  const sumRes = await db.query(
    `SELECT SUM(CASE WHEN type='debit' THEN amount ELSE 0 END) AS total_debits,
            SUM(CASE WHEN type='credit' THEN amount ELSE 0 END) AS total_credits,
            SUM(CASE WHEN type='debit' THEN amount ELSE -amount END) AS current_balance
     FROM khata_transactions WHERE customer_id=$1 AND store_id=$2`,
    [customerId, storeId]);
  return { transactions: txRes.rows, summary: sumRes.rows[0], page, limit };
}

async function getKhataAgeingReport(storeId) {
  const r = await db.query(
    `SELECT c.id, c.name, c.mobile, c.khata_balance,
       MAX(kt.created_at) AS last_transaction_at,
       CASE
         WHEN EXTRACT(DAY FROM NOW()-MAX(kt.created_at)) <= 30 THEN '0-30d'
         WHEN EXTRACT(DAY FROM NOW()-MAX(kt.created_at)) <= 60 THEN '31-60d'
         WHEN EXTRACT(DAY FROM NOW()-MAX(kt.created_at)) <= 90 THEN '61-90d'
         ELSE '90d+'
       END AS ageing_bucket
     FROM customers c
     JOIN khata_transactions kt ON kt.customer_id=c.id AND kt.store_id=c.store_id
     WHERE c.store_id=$1 AND c.khata_balance > 0
     GROUP BY c.id ORDER BY c.khata_balance DESC`,
    [storeId]);
  return r.rows;
}

module.exports = { getKhataBalance, recordKhataPayment, getKhataStatement, getKhataAgeingReport };
