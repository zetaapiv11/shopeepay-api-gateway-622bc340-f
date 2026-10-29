'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { injectAmount, crc16, parseTlv, QrisError } = require('../src/utils/qris');

// QRIS statis rekaan untuk pengujian (bukan milik siapa pun).
function buildStatic() {
  const merchant = '0016ID.EXAMPLE.TEST000212TESTMERCHANT'; // isi tag 26
  const parts =
    '000201' +
    '010211' +
    '26' + String(merchant.length).padStart(2, '0') + merchant +
    '52045411' +
    '5303360' +
    '5802ID' +
    '5909TEST SHOP' +
    '6007JAKARTA' +
    '6304';
  return parts + crc16(parts);
}

test('injectAmount menyisipkan tag 54, mengubah tag 01 ke 12, dan CRC valid', () => {
  const out = injectAmount(buildStatic(), 15000);
  const items = parseTlv(out);
  const tags = items.map((i) => i.tag);

  assert.equal(items.find((i) => i.tag === '01').value, '12');
  assert.equal(items.find((i) => i.tag === '54').value, '15000');
  assert.equal(tags[tags.length - 1], '63');
  assert.ok(tags.indexOf('54') > tags.indexOf('53') && tags.indexOf('54') < tags.indexOf('58'));
  assert.equal(crc16(out.slice(0, -4)), out.slice(-4));
});

test('injectAmount mengganti tag 54 lama, bukan menduplikasi', () => {
  const once = injectAmount(buildStatic(), 10000);
  const twice = injectAmount(once, 25000);
  const amounts = parseTlv(twice).filter((i) => i.tag === '54');
  assert.equal(amounts.length, 1);
  assert.equal(amounts[0].value, '25000');
});

test('QRIS dengan CRC salah ditolak', () => {
  const bad = buildStatic().slice(0, -4) + '0000';
  assert.throws(() => injectAmount(bad, 1000), QrisError);
});

test('nominal tidak valid ditolak', () => {
  assert.throws(() => injectAmount(buildStatic(), 0), QrisError);
  assert.throws(() => injectAmount(buildStatic(), 10.5), QrisError);
});

test('CRC16-CCITT-FALSE vektor uji standar', () => {
  assert.equal(crc16('123456789'), '29B1');
});
