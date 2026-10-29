'use strict';

/**
 * Pemantau pembayaran otomatis.
 * - Hanya memanggil provider bila ada invoice PENDING (saat sepi: nol request ke provider).
 * - Satu panggilan daftar mutasi dicocokkan ke SEMUA invoice pending sekaligus.
 * - Saat token ditolak provider, pemantauan dijeda 5 menit agar token tidak ditembak terus.
 * Aman dijalankan di beberapa instance: penandaan lunas dikunci di database (markPaid).
 */

const config = require('../config');
const logger = require('../utils/logger');
const provider = require('./paymentProvider');
const invoices = require('./invoices');
const telegram = require('./telegram');
const callbacks = require('./callbacks');
const { matchPending } = require('../utils/matching');

const PAUSE_ON_INVALID_MS = 5 * 60 * 1000;

let timer = null;
let running = false;
let started = false;
let pausedUntil = 0;
let lastErrorCode = null;

async function tick() {
  if (running || Date.now() < pausedUntil) return;
  running = true;
  try {
    if (!provider.capabilities().canCheckPayment) {
      lastErrorCode = 'NOT_CONFIGURED';
      return;
    }

    await invoices.expireStale();
    const pending = await invoices.listPending(200);
    if (pending.length === 0) {
      lastErrorCode = null;
      return;
    }

    const earliest = Math.min(...pending.map((p) => new Date(p.created_at).getTime()));
    const startDate = new Date(earliest - 60 * 1000);
    const txs = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await provider.getTransactions({ page, limit: 100, startDate, endDate: new Date() });
      txs.push(...batch);
      if (batch.length < 100) break;
    }
    lastErrorCode = null;

    for (const { invoice, tx } of matchPending(pending, txs)) {
      const r = await invoices.markPaid(
        invoice.id,
        { id: tx.id, amount: tx.amount, currency: tx.currency },
        'watcher',
        { issuer: tx.issuer, provider_time: tx.time }
      );
      if (r.result === 'PAID') {
        logger.info('Pembayaran terverifikasi', { order_id: invoice.order_id });
        telegram.notifyPaymentVerified(r.invoice, { id: tx.id, issuer: tx.issuer });
        callbacks.kick();
      }
    }
  } catch (err) {
    lastErrorCode = err.code || 'WATCHER_ERROR';
    logger.warn('Pemantauan pembayaran gagal', { code: lastErrorCode, message: err.message });
    if (err.code === 'PROVIDER_TOKEN_INVALID') {
      pausedUntil = Date.now() + PAUSE_ON_INVALID_MS;
      telegram.notifyIntegrationError(err.code, 'Token sesi ditolak. Perbarui token (POST /update-token atau env SHOPEE_TOKEN).');
    }
  } finally {
    running = false;
  }
}

function start() {
  if (config.watchIntervalSeconds <= 0) {
    logger.info('Pemantauan pembayaran otomatis dinonaktifkan (WATCH_INTERVAL_SECONDS=0)');
    return;
  }
  started = true;
  timer = setInterval(tick, config.watchIntervalSeconds * 1000);
  setTimeout(tick, 2000);
}

function stop() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

/** true bila watcher sehat; /check-payment lalu cukup membaca database tanpa menembak provider. */
function isActive() {
  return started && Date.now() >= pausedUntil && lastErrorCode === null;
}

module.exports = { start, stop, tick, isActive };
