'use strict';

const config = require('../config');
const { AppError } = require('./errors');

const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'];

function validateAmount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount harus berupa bilangan bulat positif (rupiah).');
  }
  if (value < config.minAmount || value > config.maxAmount) {
    throw new AppError(
      400,
      'AMOUNT_OUT_OF_RANGE',
      `amount harus antara ${config.minAmount} dan ${config.maxAmount}.`
    );
  }
  return value;
}

function validateOrderId(value) {
  if (typeof value !== 'string' || !ORDER_ID_RE.test(value)) {
    throw new AppError(
      400,
      'INVALID_ORDER_ID',
      'order_id harus 3-64 karakter: huruf, angka, titik, garis bawah, atau strip (diawali huruf/angka).'
    );
  }
  return value;
}

function validateEventId(value) {
  if (typeof value !== 'string' || !EVENT_ID_RE.test(value)) {
    throw new AppError(400, 'INVALID_EVENT_ID', 'event_id tidak valid.');
  }
  return value;
}

function validateUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function parsePositiveInt(raw, name, fallback, min, max) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new AppError(400, 'INVALID_PARAMETER', `${name} harus berupa bilangan bulat.`);
  }
  const n = parseInt(raw, 10);
  if (n < min || n > max) {
    throw new AppError(400, 'INVALID_PARAMETER', `${name} harus antara ${min} dan ${max}.`);
  }
  return n;
}

function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  return {
    page: parsePositiveInt(query.page, 'page', 1, 1, 100000),
    limit: parsePositiveInt(query.limit, 'limit', defaultLimit, 1, maxLimit),
  };
}

function parseStatus(raw) {
  if (raw === undefined || raw === '') return null;
  const s = String(raw).toUpperCase();
  if (!STATUSES.includes(s)) {
    throw new AppError(400, 'INVALID_STATUS', `status harus salah satu dari: ${STATUSES.join(', ')}.`);
  }
  return s;
}

/**
 * Tanggal "YYYY-MM-DD" ditafsirkan WIB (UTC+7). Batas akhir bersifat eksklusif;
 * untuk tanggal murni batas akhir digeser +1 hari sehingga tanggal itu ikut tercakup.
 */
function parseDateParam(raw, name, { isEnd = false } = {}) {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new AppError(400, 'INVALID_DATE', `${name} tidak valid.`);
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date = new Date(`${raw}T00:00:00+07:00`);
    if (!Number.isNaN(date.getTime()) && isEnd) date = new Date(date.getTime() + 24 * 3600 * 1000);
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'INVALID_DATE', `${name} harus berformat YYYY-MM-DD atau ISO 8601.`);
  }
  return date;
}

module.exports = {
  validateAmount,
  validateOrderId,
  validateEventId,
  validateUuid,
  parsePagination,
  parseStatus,
  parseDateParam,
};
