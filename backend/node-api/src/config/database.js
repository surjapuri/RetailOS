'use strict';

const { Pool } = require('pg');
const logger   = require('../utils/logger');

let pool;

function initDB() {
  pool = new Pool({
    connectionString:     process.env.DB_URL,
    max:                  20,           // max pool connections
    idleTimeoutMillis:    30_000,
    connectionTimeoutMillis: 5_000,
    // SSL in production
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true }
      : false,
  });

  pool.on('error', (err) => {
    logger.error('Postgres pool error:', err);
  });

  return pool.query('SELECT 1'); // test connection
}

/**
 * Execute a query with optional RLS store context.
 * Setting app.current_store_id enables Row-Level Security.
 */
async function query(sql, params = [], storeId = null) {
  const client = await pool.connect();
  try {
    if (storeId) {
      // Set RLS context variable for this transaction
      await client.query(
        `SET LOCAL app.current_store_id = '${storeId}'`
      );
    }
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * Run multiple queries in a single transaction.
 * @param {Function} callback - receives (client) for queries
 * @param {string}   storeId  - optional RLS context
 */
async function transaction(callback, storeId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (storeId) {
      await client.query(`SET LOCAL app.current_store_id = '${storeId}'`);
    }
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Paginated query helper.
 */
async function paginate(sql, params, { page = 1, limit = 20 } = {}, storeId = null) {
  const offset     = (page - 1) * limit;
  const countSql   = `SELECT COUNT(*) FROM (${sql}) AS _count`;
  const dataSql    = `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  const [countResult, dataResult] = await Promise.all([
    query(countSql, params, storeId),
    query(dataSql, [...params, limit, offset], storeId),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  return {
    data:        dataResult.rows,
    pagination:  { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

const db = { query, transaction, paginate };

module.exports = { initDB, db, get pool() { return pool; } };
