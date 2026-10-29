'use strict';

/**
 * Tanda tangan callback: header  X-Gateway-Signature: t=<unix>,v1=<hex>
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
 * Penerima WAJIB memverifikasi memakai body mentah (string persis seperti diterima).
 */
const crypto = require('crypto');

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function buildHeader(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
}

function verifyHeader(secret, header, body, { toleranceSec = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || typeof parts.v1 !== 'string') return false;
  if (Math.abs(now - t) > toleranceSec) return false; // cegah replay

  const expected = Buffer.from(sign(secret, t, body), 'hex');
  let given;
  try {
    given = Buffer.from(parts.v1, 'hex');
  } catch (_) {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { sign, buildHeader, verifyHeader };
