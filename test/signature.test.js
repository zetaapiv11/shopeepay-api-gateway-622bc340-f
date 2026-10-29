'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHeader, verifyHeader } = require('../src/utils/signature');

const SECRET = 'unit-test-callback-secret-123';
const BODY = JSON.stringify({ event: 'payment.paid', order_id: 'ORDER-123', amount: 15000 });

test('tanda tangan valid lolos verifikasi', () => {
  const header = buildHeader(SECRET, BODY);
  assert.equal(verifyHeader(SECRET, header, BODY), true);
});

test('body diubah, secret salah, atau header rusak ditolak', () => {
  const header = buildHeader(SECRET, BODY);
  assert.equal(verifyHeader(SECRET, header, BODY.replace('15000', '1')), false);
  assert.equal(verifyHeader('secret-lain-yang-salah-123', header, BODY), false);
  assert.equal(verifyHeader(SECRET, 'sembarang', BODY), false);
  assert.equal(verifyHeader(SECRET, undefined, BODY), false);
});

test('timestamp kedaluwarsa ditolak (anti replay)', () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(verifyHeader(SECRET, buildHeader(SECRET, BODY, old), BODY), false);
});
