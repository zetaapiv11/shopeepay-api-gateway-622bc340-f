'use strict';

/**
 * Penyuntik nominal QRIS (EMVCo TLV).
 *
 * PENTING: ini mengubah QRIS STATIS milik merchant menjadi payload bernominal
 * ("static_injected"), BUKAN invoice dinamis yang diterbitkan provider. Tidak ada
 * jaminan dari provider bahwa payload hasil modifikasi akan diterima oleh semua
 * aplikasi pembayaran. Nonaktifkan dengan mengosongkan QRIS_STATIC.
 */

class QrisError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QrisError';
    this.code = 'INVALID_QRIS_STATIC';
  }
}

/** CRC16-CCITT (poly 0x1021, init 0xFFFF) sesuai spesifikasi EMVCo QR. */
function crc16(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseTlv(text) {
  const items = [];
  let i = 0;
  while (i < text.length) {
    const tag = text.slice(i, i + 2);
    const lenText = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenText)) {
      throw new QrisError('Format TLV QRIS statis tidak valid.');
    }
    const len = parseInt(lenText, 10);
    const value = text.slice(i + 4, i + 4 + len);
    if (value.length !== len) throw new QrisError('Panjang field QRIS statis tidak konsisten.');
    items.push({ tag, value });
    i += 4 + len;
  }
  return items;
}

function serialize(items) {
  return items
    .map(({ tag, value }) => {
      if (value.length > 99) throw new QrisError('Field QRIS melebihi 99 karakter.');
      return tag + String(value.length).padStart(2, '0') + value;
    })
    .join('');
}

/**
 * @param {string} qrisStatic payload QRIS statis lengkap (dengan CRC)
 * @param {number} amount nominal rupiah (integer positif)
 * @returns {string} payload QRIS bernominal dengan CRC dihitung ulang
 */
function injectAmount(qrisStatic, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new QrisError('Nominal tidak valid.');

  const raw = String(qrisStatic || '').trim();
  if (raw.length < 30) throw new QrisError('QRIS_STATIC kosong atau terlalu pendek.');

  const items = parseTlv(raw);
  const last = items[items.length - 1];
  if (!last || last.tag !== '63' || last.value.length !== 4) {
    throw new QrisError('QRIS statis harus diakhiri tag CRC (63).');
  }
  if (crc16(raw.slice(0, -4)) !== last.value.toUpperCase()) {
    throw new QrisError('CRC QRIS statis tidak cocok; periksa kembali nilai QRIS_STATIC.');
  }

  const body = items.slice(0, -1);

  const currency = body.find((x) => x.tag === '53');
  if (!currency || currency.value !== '360') {
    throw new QrisError('QRIS statis harus bermata uang IDR (tag 53 = 360).');
  }

  const method = body.find((x) => x.tag === '01');
  if (!method) throw new QrisError('Tag 01 (point of initiation) tidak ditemukan.');
  method.value = '12'; // 11 = statis, 12 = dinamis

  const withoutAmount = body.filter((x) => x.tag !== '54');
  let insertAt = 0;
  withoutAmount.forEach((x, idx) => {
    if (x.tag < '54') insertAt = idx + 1;
  });
  withoutAmount.splice(insertAt, 0, { tag: '54', value: String(amount) });

  const payload = serialize(withoutAmount) + '6304';
  return payload + crc16(payload);
}

module.exports = { injectAmount, crc16, parseTlv, QrisError };
