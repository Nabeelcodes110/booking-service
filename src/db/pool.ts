import { Pool, types, type PoolClient, type PoolConfig } from 'pg';
import type { Config } from '../config';

// bigint (OID 20) arrives as a string so a value above 2^53 never silently becomes an imprecise JS number.
types.setTypeParser(20, (v) => v);

/** Convert a bigint column string to a JS number, refusing anything outside the safe-integer range. */
export function toSafeInt(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || (typeof value === 'string' && BigInt(value) !== BigInt(n))) {
    throw new RangeError(`value ${value} is not a safe integer`);
  }
  return n;
}

export function createPool(
  config: Pick<Config, 'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_STATEMENT_TIMEOUT_MS'>,
  extra: PoolConfig = {},
): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 5000, // bounded wait for a pooled client, then fail (-> 503); never queue forever
    idleTimeoutMillis: 30_000,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    ...extra,
  });
}

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure
const MAX_ATTEMPTS = 3;

export function isRetryable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && RETRYABLE_SQLSTATES.has((err as { code?: string }).code ?? '');
}

export interface TxOptions {
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ';
  readOnly?: boolean;
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Run fn inside ONE transaction on ONE checked-out client; every query in fn must use that client.
 * Rolls back on any error and always releases the client. Only deadlock/serialization failures
 * re-run the whole transaction (bounded); every other error propagates after rollback.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}${opts.readOnly ? ' READ ONLY' : ''}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true; // connection is broken: drop it rather than return it to the pool
      }
      if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
        opts.onRetry?.(attempt, err);
        continue; // finally still releases this client before the next attempt
      }
      throw err;
    } finally {
      client.release(destroy);
    }
  }
}
