'use strict';

require('dotenv').config();

const env = process.env;

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const nodeEnv = env.NODE_ENV || 'development';

const config = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  isDev: nodeEnv === 'development',

  port: int(env.PORT, 3001),
  host: '0.0.0.0',

  apiKey: env.API_KEY || '',
  shopeeToken: (env.SHOPEE_TOKEN || '').trim(),
  shopeeApiBase: (env.SHOPEE_API_BASE || '').trim(),
  shopeeListPath: (env.SHOPEE_LIST_PATH || '/get-transaction-list').trim(),
  qrisStatic: (env.QRIS_STATIC || '').trim(),

  telegramBotToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: (env.TELEGRAM_CHAT_ID || '').trim(),

  databaseUrl: (env.DATABASE_URL || '').trim(),
  databaseSsl: (env.DATABASE_SSL || 'auto').toLowerCase(),
  dbPoolMax: int(env.DB_POOL_MAX, 10),

  publicBaseUrl: (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  invoiceTtlMinutes: int(env.INVOICE_TTL_MINUTES, 15),
  minAmount: int(env.MIN_AMOUNT, 1000),
  maxAmount: int(env.MAX_AMOUNT, 10000000),
  uniqueCodeMax: Math.max(0, Math.min(int(env.UNIQUE_CODE_MAX, 0), 999)),

  rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 120),
  minCheckIntervalMs: Math.max(0, int(env.MIN_CHECK_INTERVAL_SECONDS, 5)) * 1000,
  providerTimeoutMs: int(env.PROVIDER_TIMEOUT_MS, 10000),

  // Pemantauan otomatis & callback ke website/bot
  watchIntervalSeconds: Math.max(0, int(env.WATCH_INTERVAL_SECONDS, 10)),
  callbackUrl: (env.CALLBACK_URL || '').trim(),
  callbackSecret: (env.CALLBACK_SECRET || '').trim(),
  callbackMaxAttempts: Math.max(1, int(env.CALLBACK_MAX_ATTEMPTS, 10)),

  autoMigrate: bool(env.AUTO_MIGRATE, false),
  // Bila true: invoice PENDING dengan nominal sama otomatis di-EXPIRED saat membuat QRIS baru (untuk testing).
  replacePendingSameAmount: bool(env.REPLACE_PENDING_SAME_AMOUNT, false),
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
};

/**
 * Validasi konfigurasi wajib. Pesan error TIDAK pernah memuat nilai variabel.
 */
config.validate = function validate() {
  const problems = [];

  if (!config.apiKey || config.apiKey.length < 16 || config.apiKey === 'replace_with_a_long_random_secret') {
    problems.push('API_KEY wajib diisi dengan string acak minimal 16 karakter (bukan nilai contoh).');
  }
  if (!config.databaseUrl) {
    problems.push('DATABASE_URL wajib diisi (connection string PostgreSQL).');
  }
  if (config.minAmount < 1 || config.maxAmount < config.minAmount) {
    problems.push('MIN_AMOUNT/MAX_AMOUNT tidak valid.');
  }
  if (config.invoiceTtlMinutes < 1 || config.invoiceTtlMinutes > 1440) {
    problems.push('INVOICE_TTL_MINUTES harus antara 1 dan 1440.');
  }
  if (config.shopeeApiBase && !/^https:\/\//i.test(config.shopeeApiBase)) {
    problems.push('SHOPEE_API_BASE harus diawali https://');
  }
  if (!config.shopeeListPath.startsWith('/')) {
    problems.push('SHOPEE_LIST_PATH harus diawali "/".');
  }

  if (config.watchIntervalSeconds > 0 && config.watchIntervalSeconds < 5) {
    problems.push('WATCH_INTERVAL_SECONDS minimal 5 (atau 0 untuk menonaktifkan).');
  }
  if (config.callbackUrl) {
    let u = null;
    try {
      u = new URL(config.callbackUrl);
    } catch (_) {
      problems.push('CALLBACK_URL bukan URL yang valid.');
    }
    if (u) {
      const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !config.isProd)) {
        problems.push('CALLBACK_URL harus https:// (http hanya untuk localhost saat development).');
      }
    }
    if (config.callbackSecret.length < 16) {
      problems.push('CALLBACK_SECRET wajib diisi minimal 16 karakter bila CALLBACK_URL dipakai.');
    }
  }

  if (problems.length) {
    const err = new Error('Konfigurasi tidak valid:\n- ' + problems.join('\n- '));
    err.isConfigError = true;
    throw err;
  }
};

module.exports = config;
