import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { createPool } from './pool';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const ADVISORY_LOCK_KEY = 727_001; // serializes concurrent migrators (e.g. API + worker starting together)

/**
 * Apply pending *.sql files in filename order, each in its own transaction, recording it in
 * schema_migrations. Idempotent and forward-only; never drops or resets data.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

// CLI: `npm run migrate`
if (require.main === module) {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const pool = createPool({ ...config, DB_POOL_MAX: 2 });
  migrate(pool)
    .then((applied) => log.info({ applied }, applied.length ? 'migrations applied' : 'schema up to date'))
    .catch((err: unknown) => {
      log.error({ err }, 'migration failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
