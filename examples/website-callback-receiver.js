'use strict';

/**
 * Contoh penerima callback di BACKEND website kamu (bukan di browser).
 * Alur: gateway -> POST /api/payment-callback -> verifikasi tanda tangan -> cocokkan pesanan -> kirim produk.
 *
 * Env: CALLBACK_SECRET (sama persis dengan di gateway), PORT
 * Jalankan contoh: node examples/website-callback-receiver.js
 */
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');

const SECRET = process.env.CALLBACK_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error('Isi CALLBACK_SECRET (min 16 karakter, sama dengan gateway).');
  process.exit(1);
}

function verify(header, rawBody, toleranceSec = 300) {
  if (typeof header !== 'string') return false;
  const p = Object.fromEntries(header.split(',').map((x) => x.trim().split('=')));
  const t = Number(p.t);
  if (!Number.isInteger(t) || !p.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(p.v1, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ====== GANTI dengan database & logika produk kamu ======
const orders = new Map(); // order_id -> { price, delivered }
async function getOrder(orderId) {
  return orders.get(orderId) || null;
}
async function deliverProduct(orderId, order) {
  // contoh: kirim email berisi akun/lisensi, buka akses member, kirim link unduhan, dll.
  console.log(`Produk untuk ${orderId} dikirim.`);
  order.delivered = true;
}
// ========================================================

const app = express();

// WAJIB body mentah: tanda tangan dihitung dari string persis yang dikirim gateway.
app.post('/api/payment-callback', express.raw({ type: 'application/json', limit: '20kb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verify(req.get('x-gateway-signature'), raw)) return res.status(401).json({ ok: false });

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch (_) {
    return res.status(400).json({ ok: false });
  }
  if (evt.event !== 'payment.paid' || evt.status !== 'PAID') return res.status(200).json({ ok: true, ignored: true });
  if (process.env.NODE_ENV === 'production' && evt.source === 'dev-simulation') return res.status(200).json({ ok: true, ignored: true });

  const order = await getOrder(evt.order_id);
  if (!order) return res.status(200).json({ ok: true, ignored: 'unknown order' }); // jangan retry selamanya
  if (order.delivered) return res.status(200).json({ ok: true, duplicate: true }); // idempotent

  // Pastikan nominal yang dibayar sesuai harga pesanan di database KAMU (bukan dari client).
  if (evt.amount !== order.price) {
    console.error(`Nominal tidak cocok untuk ${evt.order_id}`);
    return res.status(200).json({ ok: true, ignored: 'amount mismatch' }); // tangani manual
  }

  try {
    await deliverProduct(evt.order_id, order);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Gagal mengirim produk:', err.message);
    return res.status(500).json({ ok: false }); // non-2xx -> gateway akan mencoba lagi
  }
});

app.listen(process.env.PORT || 4000, () => console.log('Penerima callback berjalan'));
