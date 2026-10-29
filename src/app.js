'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./utils/logger');
const db = require('./database/db');
const { runMigrations } = require('./database/migrate');
const { AppError } = require('./utils/errors');
const { ProviderError } = require('./services/paymentProvider');
const provider = require('./services/paymentProvider');

const healthRoutes = require('./routes/health');
const tokenRoutes = require('./routes/token');
const qrisRoutes = require('./routes/qris');
const transactionRoutes = require('./routes/transactions');
const callbackRoutes = require('./routes/callbacks');
const watcher = require('./services/watcher');
const callbacks = require('./services/callbacks');
const webhookRoutes = require('./routes/webhooks');

function requestLogger(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    // Hanya path (tanpa query string/header/body) agar tidak ada secret di log.
    logger.info('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
}

function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan.'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Terjadi kesalahan pada server.';

  if (err instanceof AppError || err instanceof ProviderError) {
    status = err.status;
    code = err.code;
    message = err.message;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Body request bukan JSON yang valid.';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Ukuran body request terlalu besar.';
  }

  if (status >= 500) {
    logger.error('Request gagal', { method: req.method, path: req.originalUrl.split('?')[0], code, error: err });
  }
  return res.status(status).json({ success: false, error: { code, message } });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render berada di belakang load balancer

  app.use(helmet());
  app.use(requestLogger);

  // Health check publik, tidak terkena rate limit.
  app.use('/api', healthRoutes);

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: config.rateLimitPerMin,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMITED', message: 'Terlalu banyak request, coba lagi nanti.' } },
    })
  );

  // Webhook memakai raw body (untuk verifikasi signature) sehingga dipasang sebelum express.json.
  app.use('/webhooks', webhookRoutes);

  app.use(express.json({ limit: '10kb' }));

  app.use('/', tokenRoutes);
  app.use('/', qrisRoutes);
  app.use('/transactions', transactionRoutes);
  app.use('/callbacks', callbackRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

let server = null;
let shuttingDown = false;

async function start() {
  config.validate();

  if (config.autoMigrate) await runMigrations();
  await db.ping();

  const app = createApp();
  server = app.listen(config.port, config.host, () => {
    const caps = provider.capabilities();
    logger.info('Server berjalan', {
      port: config.port,
      env: config.nodeEnv,
      provider: caps.provider,
      can_create_invoice: caps.canCreateInvoice,
      can_check_payment: caps.canCheckPayment,
      auto_watch: config.watchIntervalSeconds > 0,
      callback: callbacks.enabled(),
    });
  });
  watcher.start();
  callbacks.start();

  server.requestTimeout = 15000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 65000; // lebih besar dari idle timeout load balancer Render
  return server;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Mematikan server', { signal });

  watcher.stop();
  callbacks.stop();

  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();

  const finish = async () => {
    try {
      await db.close();
    } catch (err) {
      logger.error('Gagal menutup pool database', { error: err });
    }
    process.exit(0);
  };

  if (server) {
    server.close(finish);
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  } else {
    finish();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { error: reason }));

module.exports = { createApp, start };

if (require.main === module) {
  start().catch((err) => {
    logger.error(err.isConfigError ? err.message : 'Gagal menjalankan server', err.isConfigError ? undefined : { error: err });
    process.exit(1);
  });
}
