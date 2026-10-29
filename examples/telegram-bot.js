'use strict';

/**
 * Contoh bot Telegram: beli produk -> bayar QRIS -> otomatis dapat produk.
 *   /produk          daftar produk
 *   /beli PREMIUM30  membuat QRIS, lalu memantau sampai lunas dan mengirim produk
 *
 * Harga SELALU diambil dari katalog di server bot (bukan dari input pelanggan).
 * Jalankan:  node examples/telegram-bot.js
 * Env: TELEGRAM_BOT_TOKEN, API_KEY, GATEWAY_URL (default http://localhost:3001)
 */
require('dotenv').config();
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.API_KEY;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';

if (!BOT_TOKEN || !API_KEY) {
  console.error('Isi TELEGRAM_BOT_TOKEN dan API_KEY di .env');
  process.exit(1);
}

// ====== GANTI dengan katalog & isi produk kamu ======
const PRODUCTS = {
  PREMIUM30: { name: 'Premium 30 Hari', price: 15000, deliver: async () => 'Akun: contoh@email.com | Sandi: (isi dari stok kamu)' },
  PREMIUM7: { name: 'Premium 7 Hari', price: 5000, deliver: async () => 'Kode voucher: (isi dari stok kamu)' },
};
// ====================================================

const tg = axios.create({ baseURL: `https://api.telegram.org/bot${BOT_TOKEN}`, timeout: 35000 });
const gateway = axios.create({
  baseURL: GATEWAY_URL,
  timeout: 15000,
  headers: { 'X-API-Key': API_KEY },
  validateStatus: () => true,
});

const send = (chat_id, text) => tg.post('/sendMessage', { chat_id, text }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function watch(chatId, orderId, expiresAt, product) {
  while (Date.now() < new Date(expiresAt).getTime() + 15000) {
    await sleep(10000);
    const res = await gateway.post('/check-payment', { order_id: orderId });
    if (res.data && res.data.paid) {
      const content = await product.deliver(orderId);
      return send(chatId, `✅ Pembayaran diterima.\n\n${product.name}\n${content}`);
    }
    if (res.data && res.data.status && res.data.status !== 'PENDING') break;
    if (res.status >= 500) break;
  }
  return send(chatId, `⌛ Invoice ${orderId} kedaluwarsa atau tidak dapat diverifikasi. Jika kamu sudah membayar, hubungi admin.`);
}

async function handle(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (/^\/produk$/.test(text)) {
    return send(chatId, Object.entries(PRODUCTS).map(([k, p]) => `${k} - ${p.name}: Rp ${p.price.toLocaleString('id-ID')}`).join('\n'));
  }
  const m = /^\/beli\s+([A-Za-z0-9_-]+)$/.exec(text);
  const product = m && PRODUCTS[m[1].toUpperCase()];
  if (!product) return send(chatId, 'Format: /beli KODE. Lihat daftar dengan /produk');

  const orderId = `TG-${chatId}-${Date.now()}`;
  const res = await gateway.post('/create-qris', { amount: product.price, order_id: orderId });
  if (!res.data || !res.data.success) {
    const msg = res.data && res.data.error ? res.data.error.message : 'Gateway tidak merespons.';
    return send(chatId, `Gagal membuat QRIS: ${msg}`);
  }
  const d = res.data.data;
  await tg.post('/sendPhoto', { chat_id: chatId, photo: d.qris_url, caption: `${product.name}\nBayar tepat Rp ${d.payable_amount.toLocaleString('id-ID')} sebelum ${d.expires_at}` }).catch(() =>
    send(chatId, `Bayar tepat Rp ${d.payable_amount.toLocaleString('id-ID')}\n${d.qris_url}`)
  );
  return watch(chatId, orderId, d.expires_at, product);
}

(async () => {
  let offset = 0;
  console.log('Bot berjalan...');
  for (;;) {
    try {
      const { data } = await tg.get('/getUpdates', { params: { offset, timeout: 25 } });
      for (const u of data.result || []) {
        offset = u.update_id + 1;
        if (u.message) handle(u.message).catch((e) => console.error('handler error:', e.message));
      }
    } catch (e) {
      console.error('polling error:', e.message);
      await sleep(3000);
    }
  }
})();
