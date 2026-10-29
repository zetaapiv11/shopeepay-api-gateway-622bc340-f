'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const http = axios.create({ timeout: 8000, maxRedirects: 0 });
const errorThrottle = new Map();
const ERROR_THROTTLE_MS = 15 * 60 * 1000;

function isConfigured() {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rupiah = (n) => 'Rp ' + new Intl.NumberFormat('id-ID').format(Number(n));

/** Tidak pernah melempar error: kegagalan notifikasi tidak boleh mengubah alur pembayaran. */
async function sendMessage(html) {
  if (!isConfigured()) return false;
  try {
    const res = await http.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        chat_id: config.telegramChatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { validateStatus: () => true }
    );
    if (res.status !== 200) {
      logger.warn('Notifikasi Telegram ditolak', { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Notifikasi Telegram gagal terkirim', { code: err.code });
    return false;
  }
}

function notifyInvoiceCreated(invoice) {
  return sendMessage(
    [
      '🧾 <b>Invoice dibuat</b>',
      `Order: <code>${esc(invoice.order_id)}</code>`,
      `Nominal bayar: <b>${esc(rupiah(invoice.payable_amount))}</b>`,
      `Kedaluwarsa: ${esc(new Date(invoice.expires_at).toISOString())}`,
    ].join('\n')
  );
}

function notifyPaymentVerified(invoice, tx = {}) {
  const lines = [
    '✅ <b>Pembayaran terverifikasi</b>',
    `Order: <code>${esc(invoice.order_id)}</code>`,
    `Nominal: <b>${esc(rupiah(invoice.payable_amount))}</b>`,
  ];
  if (tx.issuer) lines.push(`Sumber: ${esc(tx.issuer)}`);
  if (tx.id) lines.push(`Ref: <code>${esc(tx.id)}</code>`);
  return sendMessage(lines.join('\n'));
}

function notifyIntegrationError(code, message) {
  const now = Date.now();
  const last = errorThrottle.get(code) || 0;
  if (now - last < ERROR_THROTTLE_MS) return Promise.resolve(false);
  errorThrottle.set(code, now);
  return sendMessage(
    ['⚠️ <b>Masalah integrasi pembayaran</b>', `Kode: <code>${esc(code)}</code>`, esc(message)].join('\n')
  );
}

module.exports = { isConfigured, notifyInvoiceCreated, notifyPaymentVerified, notifyIntegrationError };
