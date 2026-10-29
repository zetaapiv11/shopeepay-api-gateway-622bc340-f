'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchPending } = require('../src/utils/matching');

const T0 = new Date('2026-10-29T10:00:00Z');
const inv = (id, amount, offsetMin = 0) => ({
  id,
  order_id: id,
  payable_amount: String(amount),
  created_at: new Date(T0.getTime() + offsetMin * 60000),
  expires_at: new Date(T0.getTime() + (offsetMin + 15) * 60000),
});
const tx = (id, amount, offsetMin, success = true) => ({
  id,
  amount,
  success,
  time: new Date(T0.getTime() + offsetMin * 60000),
});

test('cocok bila nominal sama, sukses, dan waktu dalam jendela invoice', () => {
  const m = matchPending([inv('A', 15000)], [tx('T1', 15000, 3)]);
  assert.equal(m.length, 1);
  assert.equal(m[0].tx.id, 'T1');
});

test('nominal beda, status gagal, atau di luar jendela waktu tidak cocok', () => {
  const pending = [inv('A', 15000)];
  assert.equal(matchPending(pending, [tx('T1', 15001, 3)]).length, 0);
  assert.equal(matchPending(pending, [tx('T2', 15000, 3, false)]).length, 0);
  assert.equal(matchPending(pending, [tx('T3', 15000, -5)]).length, 0); // sebelum invoice dibuat
  assert.equal(matchPending(pending, [tx('T4', 15000, 20)]).length, 0); // setelah kedaluwarsa
});

test('toleransi 60 detik sebelum pembuatan invoice', () => {
  const t = { ...tx('T5', 15000, 0), time: new Date(T0.getTime() - 30000) };
  assert.equal(matchPending([inv('A', 15000)], [t]).length, 1);
});

test('satu transaksi tidak boleh dipakai dua invoice', () => {
  const m = matchPending([inv('A', 15000, 0), inv('B', 15000, 1)], [tx('T6', 15000, 5)]);
  assert.equal(m.length, 1);
  assert.equal(m[0].invoice.id, 'A'); // yang paling lama didahulukan
});

test('transaksi tanpa waktu tidak pernah dicocokkan', () => {
  assert.equal(matchPending([inv('A', 15000)], [{ id: 'T7', amount: 15000, success: true, time: null }]).length, 0);
});
