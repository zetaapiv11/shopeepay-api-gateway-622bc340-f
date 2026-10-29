'use strict';

/**
 * Callback keluar: setelah invoice benar-benar lunas, gateway mengirim POST bertanda tangan
 * ke CALLBACK_URL (website/bot kamu) agar produk langsung diberikan.
 * - Antrean tersimpan di PostgreSQL (callback_deliveries), jadi tidak hilang saat restart.
 * - Retry dengan backoff eksponensial sampai CALLBACK_MAX_ATTEMPTS, lalu FAILED + alert Telegram.
 * - Pengiriman bersifat at-least-once: penerima harus idempotent (pakai event_id/order_id).
 */

const axios = require('axios');
const config = require('../config');
const db = require('../database/db');
const logger = require('../utils/logger');
const telegram = require('./telegram');
const { buildHeader } = require('../utils/signature');

const http = axios.create({
  timeout: 10000,
  maxRedirects: 0,
  validateStatus: () => true,
  transformRequest: [(data) => data],
});

let timer = null;
let processing = false;

function enabled() {
  return Boolean(config.callbackUrl && config.callbackSecret);
}

async function claimDue(limit) {
  const { rows } = await db.query(
    `UPDATE callback_deliveries
        SET next_attempt_at = now() + interval '60 seconds', updated_at = now()
      WHERE id IN (
        SELECT id FROM callback_deliveries
         WHERE status = 'PENDING' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limit]
  );
  return rows;
}

async function send(row) {
  const body = JSON.stringify(row.payload);
  try {
    const res = await http.post(config.callbackUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'shopeepay-api-gateway/1.0',
        'X-Gateway-Event': row.event_type,
        'X-Gateway-Event-Id': row.payload.event_id,
        'X-Gateway-Signature': buildHeader(config.callbackSecret, body),
      },
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, error: err.code || 'REQUEST_FAILED' };
  }
}

async function processDue() {
  if (!enabled() || processing) return 0;
  processing = true;
  let handled = 0;
  try {
    const rows = await claimDue(10);
    for (const row of rows) {
      const result = await send(row);
      handled++;
      if (result.ok) {
        await db.query(
          `UPDATE callback_deliveries
              SET status = 'DELIVERED', attempts = attempts + 1, last_status_code = $2,
                  last_error = NULL, delivered_at = now(), updated_at = now()
            WHERE id = $1`,
          [row.id, result.status]
        );
        logger.info('Callback terkirim', { order_id: row.payload.order_id });
        continue;
      }

      const attempts = row.attempts + 1;
      const failed = attempts >= config.callbackMaxAttempts;
      const delaySec = Math.min(10 * 2 ** (attempts - 1), 3600);
      await db.query(
        `UPDATE callback_deliveries
            SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
                next_attempt_at = now() + make_interval(secs => $6), updated_at = now()
          WHERE id = $1`,
        [row.id, failed ? 'FAILED' : 'PENDING', attempts, result.status || null, result.error || null, delaySec]
      );
      logger.warn('Callback gagal', { order_id: row.payload.order_id, attempts, status: result.status, code: result.error });
      if (failed) {
        telegram.notifyIntegrationError(
          'CALLBACK_FAILED',
          `Callback untuk order ${row.payload.order_id} gagal setelah ${attempts} percobaan. Pelanggan sudah membayar; kirim ulang lewat POST /callbacks/retry.`
        );
      }
    }
  } catch (err) {
    logger.error('Pemrosesan callback gagal', { error: err });
  } finally {
    processing = false;
  }
  return handled;
}

/** Percepat pengiriman tepat setelah invoice lunas (tanpa menunggu interval worker). */
function kick() {
  if (enabled()) setImmediate(() => processDue().catch(() => {}));
}

function start() {
  if (!enabled()) {
    logger.info('Callback dinonaktifkan (CALLBACK_URL/CALLBACK_SECRET belum diisi)');
    return;
  }
  timer = setInterval(() => processDue().catch(() => {}), 5000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function list({ status, page, limit }) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE c.status = $1`;
  }
  const total = await db.query(`SELECT COUNT(*)::int AS n FROM callback_deliveries c ${where}`, params);
  const p = [...params, limit, (page - 1) * limit];
  const rows = await db.query(
    `SELECT c.id, i.order_id, c.event_type, c.status, c.attempts, c.next_attempt_at,
            c.last_status_code, c.last_error, c.delivered_at, c.created_at
       FROM callback_deliveries c JOIN invoices i ON i.id = c.invoice_id
       ${where}
      ORDER BY c.created_at DESC
      LIMIT $${p.length - 1} OFFSET $${p.length}`,
    p
  );
  return { items: rows.rows, total: total.rows[0].n };
}

async function retry(orderId) {
  const { rowCount } = await db.query(
    `UPDATE callback_deliveries
        SET status = 'PENDING', attempts = 0, next_attempt_at = now(), updated_at = now()
      WHERE status IN ('FAILED','PENDING')
        AND invoice_id = (SELECT id FROM invoices WHERE order_id = $1)`,
    [orderId]
  );
  if (rowCount > 0) kick();
  return rowCount;
}

module.exports = { enabled, processDue, kick, start, stop, list, retry };
