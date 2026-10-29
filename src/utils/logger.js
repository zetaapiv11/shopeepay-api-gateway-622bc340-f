'use strict';

/**
 * Logger JSON sederhana dengan redaksi otomatis:
 * - key sensitif (token, secret, key, authorization, dst.) diganti [REDACTED]
 * - nilai rahasia dari environment (dan yang didaftarkan lewat addSecret) dihapus dari string
 * - pola connection string PostgreSQL dan token bot Telegram dihapus
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

const SENSITIVE_KEY = /token|secret|api[-_]?key|authorization|password|passwd|signature|database|cookie|qris_static|qris_payload/i;
const SECRET_ENV_NAMES = [
  'API_KEY',
  'SHOPEE_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'DATABASE_URL',
  'QRIS_STATIC',
  'CALLBACK_URL',
  'CALLBACK_SECRET',
];

const extraSecrets = new Set();

function addSecret(value) {
  if (typeof value === 'string' && value.length >= 6) extraSecrets.add(value);
}

function secretValues() {
  const values = [...extraSecrets];
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (v && v.length >= 6) values.push(v);
  }
  return values;
}

function scrub(text) {
  let out = String(text);
  for (const secret of secretValues()) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[REDACTED]');
  out = out.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]');
  return out;
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, code: value.code, message: scrub(value.message) };
  }
  if (typeof value === 'string') return scrub(value);
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[Object]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(val, depth + 1);
  }
  return out;
}

function write(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: scrub(msg),
    ...(meta ? sanitize(meta) : {}),
  });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  addSecret,
  scrub,
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
