'use strict';

/**
 * Adapter provider pembayaran.
 *
 * Mode yang tersedia (dipilih otomatis dari konfigurasi):
 *  - createInvoice   : aktif bila QRIS_STATIC terisi -> payload QRIS statis disuntik nominal
 *                      (qris_kind = "static_injected"; BUKAN invoice dari provider).
 *  - getPaymentStatus / getTransactions / validateCredentials :
 *                      aktif bila SHOPEE_TOKEN dan SHOPEE_API_BASE terisi -> membaca daftar mutasi
 *                      Partner Portal memakai token SESI (tidak resmi, tidak terdokumentasi).
 *  - verifyWebhook   : belum didukung (signature webhook ShopeePay tidak terdokumentasi).
 *
 * Bila komponen tidak dikonfigurasi, method melempar ProviderError('NOT_CONFIGURED').
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { injectAmount, QrisError } = require('../utils/qris');

class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

const PROVIDER_NAME = 'shopee-session';
const VALIDATION_CACHE_MS = 5 * 60 * 1000;

const state = {
  token: config.shopeeToken,
  validation: null, // { state, message, checkedAt }
};
logger.addSecret(state.token);

const http = axios.create({
  timeout: config.providerTimeoutMs,
  maxRedirects: 0,
  maxContentLength: 2 * 1024 * 1024,
  validateStatus: () => true,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
});

// ============================================================================
// BLOK TERGANTUNG-CAPTURE
// ----------------------------------------------------------------------------
// Yang BENAR-BENAR terverifikasi dari dokumentasi repo referensi hanya:
//   * token ada di body request: data -> metadata -> token
//   * ada endpoint "get-transaction-list"
//   * kode error token mati: 200020
// Nama field lain di bawah (filter waktu, paginasi, kunci array respons, nama
// field transaksi) adalah ASUMSI AWAL. Cocokkan dengan hasil capture request
// akun merchant kamu sendiri (DevTools > Network) sebelum dipakai produksi.
// ============================================================================

const toEpochSeconds = (d) => Math.floor(d.getTime() / 1000);

// Format request ini cocok dengan hasil capture DevTools akun merchant (get-transaction-list).
function buildListPayload(token, { limit, startDate, endDate }) {
  return {
    data: {
      metadata: { token, language: 'id', timezone: 'Asia/Jakarta' },
      pageSize: limit,
      filter: {
        startTime: toEpochSeconds(startDate),
        endTime: toEpochSeconds(endDate),
        serviceList: [1, 3],
      },
      sorter: { field: 'createTime', order: 'descend' },
      next_position: '',
    },
  };
}

function isAuthError(httpStatus, body) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const code = body && (body.code ?? body.error_code ?? (body.data && body.data.code));
  return String(code) === '200020';
}

function extractList(body) {
  const d = body && body.data;
  const candidates = [d && d.transactions, d && d.transaction_list, d && d.list, body && body.transactions];
  return candidates.find(Array.isArray) || null;
}

function normalizeTransaction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.transaction_id ?? raw.transactionId ?? raw.id ?? raw.order_sn ?? null;
  const amount = parseAmount(raw.amount ?? raw.transaction_amount ?? raw.total_amount);
  if (id === null || amount === null) return null;

  const status = String(raw.status ?? raw.transaction_status ?? '').toLowerCase();
  return {
    id: String(id),
    amount,
    currency: 'IDR',
    status,
    success: ['success', 'successful', 'completed', 'paid'].includes(status),
    time: parseTime(raw.time ?? raw.transaction_time ?? raw.create_time ?? raw.created_at),
    issuer: raw.issuer ?? raw.payment_method ?? null,
  };
}
// ===================== AKHIR BLOK TERGANTUNG-CAPTURE ========================

function parseAmount(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  if (/^\d+\.0+$/.test(s)) return Number(s.split('.')[0]);
  return null;
}

function validDate(d) {
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return validDate(new Date(v < 1e12 ? v * 1000 : v));
  const s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) return parseTime(Number(s));
  // Format tanpa zona waktu ("YYYY-MM-DD HH:mm:ss") diasumsikan WIB (UTC+7).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return validDate(new Date(s.replace(' ', 'T') + '+07:00'));
  }
  return validDate(new Date(s));
}

function hasSession(token) {
  return Boolean(token && config.shopeeApiBase);
}

function notConfigured(message) {
  return new ProviderError('NOT_CONFIGURED', message, 501);
}

async function postJson(path, payload, token) {
  const url = config.shopeeApiBase.replace(/\/+$/, '') + path;
  let res;
  try {
    res = await http.post(url, payload);
  } catch (err) {
    logger.warn('Provider tidak dapat dihubungi', { code: err.code });
    throw new ProviderError('PROVIDER_UNREACHABLE', 'Provider tidak dapat dihubungi.', 502);
  }

  if (isAuthError(res.status, res.data)) {
    if (token === state.token) {
      state.validation = { state: 'INVALID', message: 'Provider menolak token.', checkedAt: new Date() };
    }
    throw new ProviderError('PROVIDER_TOKEN_INVALID', 'Provider menolak token sesi (kedaluwarsa atau tidak valid).', 502);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError('PROVIDER_HTTP_ERROR', `Provider membalas HTTP ${res.status}.`, 502);
  }
  return res.data;
}

async function fetchList(token, { page, limit, startDate, endDate }) {
  const body = await postJson(
    config.shopeeListPath,
    buildListPayload(token, { page, limit, startDate, endDate }),
    token
  );
  const raw = extractList(body);
  if (!raw) return { recognized: false, transactions: [] };
  return { recognized: true, transactions: raw.map(normalizeTransaction).filter(Boolean) };
}

// ----------------------------- Interface publik -----------------------------

function capabilities() {
  return {
    provider: PROVIDER_NAME,
    canCreateInvoice: Boolean(config.qrisStatic),
    canCheckPayment: hasSession(state.token),
    webhookSupported: false,
  };
}

async function validateCredentials({ token } = {}) {
  const tk = token || state.token;
  if (!hasSession(tk)) {
    return {
      state: 'NOT_CONFIGURED',
      message: 'SHOPEE_TOKEN dan/atau SHOPEE_API_BASE belum diisi.',
      checkedAt: new Date(),
    };
  }
  const cached = state.validation;
  if (!token && cached && Date.now() - cached.checkedAt.getTime() < VALIDATION_CACHE_MS) return cached;

  let result;
  try {
    const now = new Date();
    const r = await fetchList(tk, {
      page: 1,
      limit: 1,
      startDate: new Date(now.getTime() - 24 * 3600 * 1000),
      endDate: now,
    });
    result = r.recognized
      ? {
          state: 'VALID',
          message: 'Provider menjawab permintaan dengan token ini (bukti uji langsung, bukan validasi resmi).',
        }
      : { state: 'UNVERIFIED', message: 'Provider menjawab, tetapi format respons tidak dikenali. Periksa blok capture.' };
  } catch (err) {
    result =
      err.code === 'PROVIDER_TOKEN_INVALID'
        ? { state: 'INVALID', message: err.message }
        : { state: 'UNVERIFIED', message: err.message };
  }
  result.checkedAt = new Date();
  if (!token) state.validation = result;
  return result;
}

async function createInvoice({ amount, orderId }) {
  if (!config.qrisStatic) {
    throw notConfigured('QRIS_STATIC belum diisi, pembuatan QRIS dinonaktifkan.');
  }
  try {
    return {
      providerInvoiceId: null, // tidak ada invoice di sisi provider pada mode ini
      qrisPayload: injectAmount(config.qrisStatic, amount),
      qrisKind: 'static_injected',
      expiresAt: new Date(Date.now() + config.invoiceTtlMinutes * 60 * 1000),
      orderId,
    };
  } catch (err) {
    if (err instanceof QrisError) throw new ProviderError(err.code, err.message, 500);
    throw err;
  }
}

/**
 * Mencari transaksi masuk yang cocok dengan invoice: status sukses, nominal sama persis,
 * waktu di antara pembuatan invoice (toleransi 60 detik) dan kedaluwarsa.
 * Pemeriksaan "sudah diklaim invoice lain" dilakukan pemanggil lewat constraint database.
 */
async function getPaymentStatus({ invoice, token }) {
  const tk = token || state.token;
  if (!hasSession(tk)) {
    throw notConfigured('SHOPEE_TOKEN/SHOPEE_API_BASE belum diisi, status pembayaran tidak dapat diverifikasi.');
  }
  if (!invoice) throw new ProviderError('INVALID_REQUEST', 'Data invoice diperlukan.', 500);

  const from = new Date(new Date(invoice.created_at).getTime() - 60 * 1000);
  const until = new Date(invoice.expires_at);
  const r = await fetchList(tk, { page: 1, limit: 100, startDate: from, endDate: new Date() });
  if (!r.recognized) {
    throw new ProviderError('PROVIDER_UNRECOGNIZED_RESPONSE', 'Format respons provider tidak dikenali.', 502);
  }

  const expected = Number(invoice.payable_amount);
  const matches = r.transactions.filter(
    (t) => t.success && t.amount === expected && t.time && t.time >= from && t.time <= until
  );
  return { state: matches.length ? 'PAID' : 'PENDING', matches };
}

async function getTransactions({ page = 1, limit = 20, startDate, endDate, token } = {}) {
  const tk = token || state.token;
  if (!hasSession(tk)) {
    throw notConfigured('SHOPEE_TOKEN/SHOPEE_API_BASE belum diisi.');
  }
  const end = endDate || new Date();
  const start = startDate || new Date(end.getTime() - 24 * 3600 * 1000);
  const r = await fetchList(tk, { page, limit, startDate: start, endDate: end });
  if (!r.recognized) {
    throw new ProviderError('PROVIDER_UNRECOGNIZED_RESPONSE', 'Format respons provider tidak dikenali.', 502);
  }
  return r.transactions;
}

/**
 * Signature webhook ShopeePay tidak terdokumentasi, jadi tidak ada validasi palsu di sini.
 * Selama belum ada dokumentasi resmi, hasilnya selalu { configured: false }.
 */
function verifyWebhook() {
  return {
    configured: false,
    valid: false,
    reason:
      'Verifikasi webhook belum dikonfigurasi: dokumentasi signature resmi ShopeePay diperlukan.',
  };
}

function setToken(newToken) {
  state.token = newToken;
  state.validation = null;
  logger.addSecret(newToken);
}

module.exports = {
  ProviderError,
  capabilities,
  validateCredentials,
  createInvoice,
  getPaymentStatus,
  getTransactions,
  verifyWebhook,
  setToken,
  _internals: { parseAmount, parseTime, normalizeTransaction },
};
