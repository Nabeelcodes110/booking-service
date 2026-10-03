import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { Client, type Pool } from 'pg';
import { createApp } from '../../src/app';
import { signToken } from '../../src/auth';
import { loadConfig, type Config } from '../../src/config';
import { createPool } from '../../src/db/pool';
import { migrate } from '../../src/db/migrate';
import { createLogger } from '../../src/logger';
import { ReservationController } from '../../src/reservations/reservation.controller';
import { ReservationRepository } from '../../src/reservations/reservation.repository';
import { reservationRoutes } from '../../src/reservations/reservation.routes';
import { ReservationService } from '../../src/reservations/reservation.service';
import { ShowController } from '../../src/shows/show.controller';
import { ShowRepository } from '../../src/shows/show.repository';
import { showRoutes } from '../../src/shows/show.routes';
import { ShowService } from '../../src/shows/show.service';

/**
 * Real-PostgreSQL integration harness: the production app (same routers/controllers/services) listening on an
 * ephemeral port, talked to over real HTTP. Tests never truncate tables; each test creates its own fresh show,
 * so they are independent and safe to run against a long-lived database.
 *
 * Database: TEST_DATABASE_URL, else DATABASE_URL (from .env) with "_test" appended to the database name. The
 * database is created if missing, so the dev database is never touched.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // no .env: rely on the real environment
}

function testDatabaseUrl(): string {
  if (process.env['TEST_DATABASE_URL']) return process.env['TEST_DATABASE_URL'];
  const base = process.env['DATABASE_URL'];
  if (!base) throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL in .env) to a PostgreSQL connection string');
  const url = new URL(base);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } catch (err) {
    // two test files starting together may race on CREATE DATABASE; the loser just needs it to exist
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await client.end();
  }
}

export const TEST_SECRET = 'test-secret-test-secret-test-secret-0123456789';

export interface Harness {
  baseUrl: string;
  pool: Pool;
  config: Config;
  token(sub: string, admin?: boolean): string;
  /** Stop accepting requests and close the pool, as a process exit would. */
  close(): Promise<void>;
}

export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const url = testDatabaseUrl();
  await ensureDatabase(url);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: url,
    DB_POOL_MAX: '20',
    DB_STATEMENT_TIMEOUT_MS: '10000',
    JWT_SECRET: TEST_SECRET,
    ...overrides,
  });
  const pool = createPool(config);
  await migrate(pool);

  const showController = new ShowController(new ShowService(pool, new ShowRepository()));
  const reservationController = new ReservationController(new ReservationService(pool, new ReservationRepository()));
  const app = createApp({
    config,
    log: createLogger('silent'),
    pool,
    routes: (auth) =>
      Router()
        .use(showRoutes(showController, auth.requireAdmin))
        .use(reservationRoutes(reservationController, auth.requireUser)),
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', 4096, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    config,
    token: (sub, admin = false) => signToken({ sub, admin }, config),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await pool.end();
    },
  };
}

export interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function client(h: Harness) {
  // Windows refuses bursts of ~200+ simultaneous loopback connects (ECONNREFUSED before the server even sees
  // them), so the load generator caps its own sockets. All requests are still submitted at once and queue
  // client-side; this is a load-generator limit, not a service one.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
  const call = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        `${h.baseUrl}${path}`,
        {
          method,
          agent,
          headers: {
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out.set(k, v);
            resolve({ status: res.statusCode ?? 0, headers: out, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Reply['body'] });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

  return {
    async createShow(seats: string[], opts: { per_user_limit?: number; price_paise?: number } = {}) {
      const r = await call('POST', '/shows', h.token('admin-1', true), { name: 'Test show', seats, price_paise: opts.price_paise ?? 10000, ...opts });
      if (r.status !== 201) throw new Error(`createShow failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body['show_id'] as string;
    },
    reserve: (showId: string, user: string, seats: string[], key: string, extra: Record<string, unknown> = {}) =>
      call('POST', `/shows/${showId}/reserve`, h.token(user), { seats, idempotency_key: key, ...extra }),
    cancel: (reservationId: string, user: string) => call('POST', `/reservations/${reservationId}/cancel`, h.token(user), {}),
    getShow: (showId: string) => call('GET', `/shows/${showId}`, null),
  };
}

/** Authoritative SQL view used to reconcile the HTTP view against the tables. */
export async function dbState(pool: Pool, showId: string) {
  const seats = await pool.query<{ held: string; total: string }>(
    'SELECT count(reservation_id) AS held, count(*) AS total FROM show_seats WHERE show_id = $1',
    [showId],
  );
  const usage = await pool.query<{ user_id: string; active_count: number }>(
    'SELECT user_id, active_count FROM user_show_usage WHERE show_id = $1',
    [showId],
  );
  // quota counter must equal the seats each user's confirmed reservations actually hold
  const owned = await pool.query<{ user_id: string; seats: string }>(
    `SELECT r.user_id, count(*) AS seats FROM show_seats s JOIN reservations r ON r.id = s.reservation_id
     WHERE s.show_id = $1 AND r.status = 'confirmed' GROUP BY r.user_id`,
    [showId],
  );
  const confirmed = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM reservations WHERE show_id = $1 AND status = 'confirmed'",
    [showId],
  );
  return {
    heldSeats: Number(seats.rows[0]?.held),
    totalSeats: Number(seats.rows[0]?.total),
    confirmedReservations: Number(confirmed.rows[0]?.n),
    quota: Object.fromEntries(usage.rows.filter((u) => u.active_count > 0).map((u) => [u.user_id, u.active_count])),
    ownedSeats: Object.fromEntries(owned.rows.map((o) => [o.user_id, Number(o.seats)])),
  };
}
