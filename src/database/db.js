'use strict';

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

let pool = null;

function sslOption() {
  if (config.databaseSsl === 'false') return false;
  if (config.databaseSsl === 'true') return { rejectUnauthorized: false };

  // auto: aktif kecuali host lokal
  try {
    const host = new URL(config.databaseUrl).hostname;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return false;
  } catch (_) {
    /* URL tidak bisa di-parse: biarkan pg yang melaporkan error koneksi */
  }
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: sslOption(),
      max: config.dbPoolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    });
    pool.on('error', (err) => logger.error('Kesalahan pada idle client PostgreSQL', { error: err }));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Rollback gagal', { error: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  await query('SELECT 1');
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { query, withTransaction, ping, close, getPool };
