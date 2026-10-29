'use strict';

const crypto = require('crypto');
const config = require('../config');
const { AppError } = require('../utils/errors');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/**
 * Autentikasi lewat header X-API-Key. Perbandingan memakai hash + timingSafeEqual.
 * Sengaja TIDAK menerima ?api_key= di query string agar kunci tidak bocor ke log/URL.
 */
function apiKey(req, res, next) {
  const provided = req.get('x-api-key');
  if (!provided || !crypto.timingSafeEqual(digest(provided), digest(config.apiKey))) {
    return next(new AppError(401, 'UNAUTHORIZED', 'API key tidak ada atau tidak valid.'));
  }
  return next();
}

module.exports = apiKey;
