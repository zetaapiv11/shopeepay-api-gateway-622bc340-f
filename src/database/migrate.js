'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 727001;

async function runMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await db.getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info('Migrasi diterapkan', { file });
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    if (count === 0) logger.info('Database sudah up-to-date');
    return count;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch (_) {
      /* koneksi akan ditutup */
    }
    client.release();
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  const config = require('../config');
  (async () => {
    try {
      config.validate();
      await runMigrations();
      await db.close();
      process.exit(0);
    } catch (err) {
      logger.error('Migrasi gagal', { error: err });
      try {
        await db.close();
      } catch (_) {
        /* abaikan */
      }
      process.exit(1);
    }
  })();
}
