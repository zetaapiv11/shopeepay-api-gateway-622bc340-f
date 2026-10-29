'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.API_KEY = 'unit-test-super-secret-key-123';
const logger = require('../src/utils/logger');

test('scrub menghapus nilai rahasia, connection string, dan token bot', () => {
  const text =
    'key=unit-test-super-secret-key-123 db=postgresql://user:pass@host/db bot=bot1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const out = logger.scrub(text);
  assert.ok(!out.includes('unit-test-super-secret-key-123'));
  assert.ok(!out.includes('user:pass'));
  assert.ok(!out.includes('AAAAAAAAAAAA'));
});

test('addSecret mendaftarkan nilai runtime', () => {
  logger.addSecret('runtime-token-abcdef');
  assert.ok(!logger.scrub('x runtime-token-abcdef y').includes('runtime-token-abcdef'));
});
