/**
 * One-command burst + correctness check against a running service (local or live).
 *
 * Usage:
 *   1. Start the API with the same JWT secret as the target service.
 *   2. BASE_URL defaults to the live deployment; set it (or --base-url) to target another service.
 *   3. Run: $env:BASE_URL = "http://localhost:3100"; $env:JWT_SECRET = "<same-secret>"; npm run burst -- --count 500 --sockets 100
 *
 * Example local run:
 *   $env:DATABASE_URL = "postgresql://<user>:<password>@localhost:5432/booking-service_test"; $env:PORT = "3100"; npm run dev
 *   $env:BASE_URL = "http://localhost:3100"; $env:JWT_SECRET = "<same-secret>"; npm run burst -- --count 500 --sockets 100
 *
 * The script mints tokens locally in the same way as `npm run token`, writes only through the public API,
 * and creates fresh shows for each scenario, so it is safe to re-run against a live database.
 *
 * Phases (all new shows):
 *   1. barrier burst, released together: hot-seat storm (--count users, one seat), per-user limit groups,
 *      same-key retry groups (+ a body-conflict probe each), while a poller reads every show's snapshot
 *   2. cancel / rebook: concurrent repeated cancels, rebooking, stale cancel, replay of the cancelled booking's key
 *   3. final reconciliation of every show via GET /shows/:id (exact counts, not just non-negative)
 *
 * Exit code is nonzero if any assertion is violated.
 */
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { signToken } from '../auth';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    count: { type: 'string' },
    sockets: { type: 'string' },
    'timeout-ms': { type: 'string' },
    'limit-users': { type: 'string' },
    'retry-groups': { type: 'string' },
    'retry-size': { type: 'string' },
    'poll-ms': { type: 'string' },
  },
});

function intOption(flag: string | undefined, env: string, fallback: number): number {
  const raw = flag ?? process.env[env];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${env} must be a positive integer (got "${raw}")`);
  return n;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const DEFAULT_BASE_URL = 'https://booking-service-83x6.onrender.com'; // live deployment; override with BASE_URL / --base-url
const baseUrl = (values['base-url'] ?? process.env['BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
const secret = process.env['JWT_SECRET'];
if (!secret || secret.length < 32) fail('JWT_SECRET (>= 32 chars, same as the target service) is required to mint tokens');
const jwtCfg = {
  JWT_SECRET: secret,
  JWT_ISSUER: process.env['JWT_ISSUER'] ?? 'booking-service',
  JWT_AUDIENCE: process.env['JWT_AUDIENCE'] ?? 'booking-api',
};

const COUNT = intOption(values.count, 'COUNT', 500); // hot-seat storm size = concurrent requests released at the barrier
const SOCKETS = intOption(values.sockets, 'SOCKETS', Math.min(COUNT, 1000)); // max simultaneous TCP connections
const TIMEOUT_MS = intOption(values['timeout-ms'], 'TIMEOUT_MS', 30_000);
const LIMIT_USERS = intOption(values['limit-users'], 'LIMIT_USERS', 20);
const RETRY_GROUPS = intOption(values['retry-groups'], 'RETRY_GROUPS', 20);
const RETRY_SIZE = intOption(values['retry-size'], 'RETRY_SIZE', 10);
const POLL_MS = intOption(values['poll-ms'], 'POLL_MS', 100);

const RUN = Date.now().toString(36);
const target = new URL(baseUrl);
const transport = target.protocol === 'https:' ? https : http;
const agent = new transport.Agent({ keepAlive: true, maxSockets: SOCKETS });
// The snapshot poller gets its own sockets so it observes the service DURING the burst instead of queueing behind it.
const pollAgent = new transport.Agent({ keepAlive: true, maxSockets: 4 });

// ---------------------------------------------------------------- HTTP client with measurement

interface Reply {
  status: number; // 0 = transport failure (reset, refused, timeout)
  code: string; // error.code, "ok", or the transport error
  replayed: boolean;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  totalMs: number; // from submission (queue wait included)
  wireMs: number; // from socket assignment to full response
}

const stats = {
  total: [] as number[],
  wire: [] as number[],
  inFlight: 0, // submitted, response not finished
  peakInFlight: 0,
  onWire: 0, // holding a socket
  peakOnWire: 0,
  byStatus: new Map<string, number>(),
  transportErrors: new Map<string, number>(),
  replays: 0,
  recovered: 0, // transport failures whose outcome was resolved by retrying the same idempotency key
  requests: 0,
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  socketPool: http.Agent = agent,
): Promise<Reply> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const submitted = performance.now();
    let socketAt = submitted;
    let onWire = false;
    let finished = false;
    stats.requests++;
    stats.inFlight++;
    stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);

    const done = (reply: Omit<Reply, 'totalMs' | 'wireMs'>): void => {
      if (finished) return;
      finished = true;
      const now = performance.now();
      stats.inFlight--;
      if (onWire) stats.onWire--;
      const totalMs = now - submitted;
      const wireMs = now - socketAt;
      stats.total.push(totalMs);
      stats.wire.push(wireMs);
      if (reply.status === 0) bump(stats.transportErrors, reply.code);
      else bump(stats.byStatus, reply.code === 'ok' ? `${reply.status}` : `${reply.status} ${reply.code}`);
      if (reply.replayed) stats.replays++;
      resolve({ ...reply, totalMs, wireMs });
    };

    const req = transport.request(
      `${baseUrl}${path}`,
      {
        method,
        agent: socketPool,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err: NodeJS.ErrnoException) => done({ status: 0, code: err.code ?? 'response_error', replayed: false, body: {} }));
        res.on('end', () => {
          let parsed: Reply['body'] = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Reply['body'];
          } catch {
            // non-JSON body (e.g. a proxy error page): status still counts, shape assertions will flag it
          }
          const status = res.statusCode ?? 0;
          done({
            status,
            code: status >= 400 ? String(parsed['error']?.code ?? 'no_error_code') : 'ok',
            replayed: res.headers['idempotent-replayed'] === 'true',
            body: parsed,
          });
        });
      },
    );
    req.on('socket', () => {
      socketAt = performance.now();
      onWire = true;
      stats.onWire++;
      stats.peakOnWire = Math.max(stats.peakOnWire, stats.onWire);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (err: NodeJS.ErrnoException) => done({ status: 0, code: err.code ?? err.message, replayed: false, body: {} }));
    req.end(payload);
  });
}

// ---------------------------------------------------------------- scenario helpers

const violations: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    violations.push(message);
    if (violations.length <= 50) process.stderr.write(`VIOLATION: ${message}\n`);
  }
}

const tokenFor = (sub: string) => signToken({ sub, ttlSeconds: 3600 }, jwtCfg);
const adminToken = signToken({ sub: `burst-admin-${RUN}`, admin: true, ttlSeconds: 3600 }, jwtCfg);
const labels = (n: number) => Array.from({ length: n }, (_, i) => `S${i + 1}`);

const reserve = (showId: string, user: string, seats: string[], key: string, extra: Record<string, unknown> = {}) =>
  call('POST', `/shows/${showId}/reserve`, tokenFor(user), { seats, idempotency_key: key, ...extra });
const cancel = (reservationId: string, user: string) => call('POST', `/reservations/${reservationId}/cancel`, tokenFor(user), {});
const getShow = (showId: string, socketPool?: http.Agent) => call('GET', `/shows/${showId}`, null, undefined, {}, socketPool);

async function createShow(seats: string[], perUserLimit?: number): Promise<string> {
  const r = await call('POST', '/shows', adminToken, {
    name: `burst ${RUN}`,
    seats,
    price_paise: 10_000,
    ...(perUserLimit === undefined ? {} : { per_user_limit: perUserLimit }),
  });
  if (r.status !== 201) fail(`setup failed: POST /shows -> ${r.status} ${r.code} (is JWT_SECRET/ISSUER/AUDIENCE the same as the service?)`);
  return r.body['show_id'] as string;
}

/** What each show must look like once everything has settled. */
const expectedConfirmed = new Map<string, { label: string; confirmed: number; total: number }>();

function count(replies: Reply[], status: number, code?: string): number {
  return replies.filter((r) => r.status === status && (code === undefined || r.code === code)).length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const started = Date.now();
  process.stdout.write(
    `burst run=${RUN} base_url=${baseUrl} count=${COUNT} sockets=${SOCKETS} timeout_ms=${TIMEOUT_MS} ` +
      `limit_users=${LIMIT_USERS} retry_groups=${RETRY_GROUPS}x${RETRY_SIZE} node=${process.version}\n`,
  );

  // ---- Setup (not part of the measured burst): fresh shows + pre-built requests.
  const hotShow = await createShow(['HOT1', 'HOT2']);
  expectedConfirmed.set(hotShow, { label: 'hot-seat', confirmed: 1, total: 2 });

  const limitShows: string[] = [];
  for (let u = 0; u < LIMIT_USERS; u++) {
    const showId = await createShow(labels(10)); // default per-user limit 4
    limitShows.push(showId);
    expectedConfirmed.set(showId, { label: `limit-${u}`, confirmed: 4, total: 10 });
  }

  const retryShows: string[] = [];
  for (let g = 0; g < RETRY_GROUPS; g++) {
    const showId = await createShow(labels(3));
    retryShows.push(showId);
    expectedConfirmed.set(showId, { label: `retry-${g}`, confirmed: 2, total: 3 });
  }

  // ---- Poller: every show must satisfy available + held + confirmed = total in every single snapshot.
  const watched = [hotShow, ...limitShows, ...retryShows];
  let polling = true;
  let polls = 0;
  const poller = (async () => {
    let i = 0;
    while (polling) {
      const showId = watched[i++ % watched.length]!;
      const r = await getShow(showId, pollAgent);
      polls++;
      if (r.status === 200) {
        const c = r.body['counts'];
        check(c.available + c.held + c.confirmed === c.total_seats, `snapshot invariant broken for ${showId}: ${JSON.stringify(c)}`);
        check(c.held === 0, `held must stay 0 (show ${showId})`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  })();

  // ---- Phase 1: everything released from one barrier.
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  // Released at the barrier. A transport failure (timeout/reset) leaves the outcome unknown, so it is resolved the way
  // a real client must: retry the SAME idempotency key, which returns the stored outcome instead of booking twice.
  // The failure itself stays counted (and fails the run); this only stops it cascading into wrong 201/409 totals.
  const gated = (fn: () => Promise<Reply>): Promise<Reply> =>
    barrier.then(async () => {
      let reply = await fn();
      for (let attempt = 1; reply.status === 0 && attempt <= 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        const retry = await fn();
        if (retry.status !== 0) {
          stats.recovered++;
          // a replayed 200 is the original 201 seen again; replayed declines keep their 409
          reply = retry.replayed && retry.status === 200 ? { ...retry, status: 201 } : retry;
        }
      }
      return reply;
    });

  const hot = Array.from({ length: COUNT }, (_, i) => gated(() => reserve(hotShow, `hot-${RUN}-${i}`, ['HOT1'], `hot-${i}`)));

  const limitGroups = limitShows.map((showId, u) =>
    labels(10).map((seat, i) => gated(() => reserve(showId, `limit-${RUN}-${u}`, [seat], `limit-${u}-${i}`))),
  );

  const retryGroups = retryShows.map((showId, g) => {
    const user = `retry-${RUN}-${g}`;
    return {
      same: Array.from({ length: RETRY_SIZE }, () => gated(() => reserve(showId, user, ['S2', 'S1'], `retry-${g}`))),
      reordered: gated(() => reserve(showId, user, ['S1', 'S2'], `retry-${g}`)),
    };
  });

  await new Promise((resolve) => setTimeout(resolve, 50)); // let every gated promise attach before release
  const burstStart = performance.now();
  release();

  const hotReplies = await Promise.all(hot);
  const limitReplies = await Promise.all(limitGroups.map((g) => Promise.all(g)));
  const retryReplies = await Promise.all(
    retryGroups.map(async (g) => ({ same: await Promise.all(g.same), reordered: await g.reordered })),
  );
  const burstSeconds = (performance.now() - burstStart) / 1000;

  // hot seat: one winner, everyone else 409 seat_taken
  check(count(hotReplies, 201) === 1, `hot seat: expected exactly 1 x 201, got ${count(hotReplies, 201)}`);
  check(count(hotReplies, 409, 'seat_taken') === COUNT - 1, `hot seat: expected ${COUNT - 1} x 409 seat_taken, got ${count(hotReplies, 409, 'seat_taken')}`);

  // limits: exactly 4 seats, 6 per_user_limit declines per user
  limitReplies.forEach((replies, u) => {
    check(count(replies, 201) === 4, `limit group ${u}: expected 4 x 201, got ${count(replies, 201)}`);
    check(count(replies, 409, 'per_user_limit') === 6, `limit group ${u}: expected 6 x 409 per_user_limit, got ${count(replies, 409, 'per_user_limit')}`);
  });

  // retries: one new booking, all others replay the same reservation; changed body conflicts
  retryReplies.forEach((g, i) => {
    const all = [...g.same, g.reordered];
    const created = all.filter((r) => r.status === 201);
    check(created.length === 1, `retry group ${i}: expected exactly 1 x 201, got ${created.length}`);
    const id = created[0]?.body['reservation_id'];
    for (const r of all.filter((x) => x.status === 200)) {
      check(r.replayed && r.body['reservation_id'] === id && r.body['amount_paise'] === 20_000, `retry group ${i}: replay differs from original`);
    }
    check(all.filter((r) => r.status === 200).length === all.length - 1, `retry group ${i}: expected ${all.length - 1} x 200 replays`);
  });

  // Same key, different body, after the original committed: always idempotency_conflict (probe is sequential on purpose).
  const conflicts = await Promise.all(retryShows.map((showId, g) => reserve(showId, `retry-${RUN}-${g}`, ['S1', 'S3'], `retry-${g}`)));
  check(count(conflicts, 409, 'idempotency_conflict') === conflicts.length, `body-conflict probes: expected ${conflicts.length} x 409 idempotency_conflict, got ${count(conflicts, 409, 'idempotency_conflict')}`);

  // ---- Phase 2: cancel / rebook on its own fresh show (sequential steps, concurrent cancels).
  const cancelShow = await createShow(['C1', 'C2']);
  expectedConfirmed.set(cancelShow, { label: 'cancel-rebook', confirmed: 1, total: 2 });
  watched.push(cancelShow);
  const owner = `cancel-owner-${RUN}`;
  const newcomer = `cancel-newcomer-${RUN}`;
  const first = await reserve(cancelShow, owner, ['C1'], 'cancel-key');
  check(first.status === 201, `cancel scenario: first booking expected 201, got ${first.status}`);
  const reservationId = first.body['reservation_id'] as string;
  const foreign = await cancel(reservationId, newcomer);
  check(foreign.status === 403, `cancel scenario: foreign cancel expected 403, got ${foreign.status}`);
  const repeats = await Promise.all(Array.from({ length: 10 }, () => cancel(reservationId, owner)));
  check(repeats.every((r) => r.status === 200 && r.body['status'] === 'cancelled'), 'cancel scenario: every repeated cancel must be 200 cancelled');
  const rebook = await reserve(cancelShow, newcomer, ['C1'], 'rebook-key');
  check(rebook.status === 201, `cancel scenario: rebooking the freed seat expected 201, got ${rebook.status}`);
  const stale = await cancel(reservationId, owner);
  check(stale.status === 200, `cancel scenario: stale repeated cancel expected 200, got ${stale.status}`);
  const replayAfterCancel = await reserve(cancelShow, owner, ['C1'], 'cancel-key');
  check(
    replayAfterCancel.status === 200 && replayAfterCancel.replayed && replayAfterCancel.body['reservation_id'] === reservationId,
    'cancel scenario: replay after cancellation must return the original reservation (200 + replay header), not rebook',
  );

  polling = false;
  await poller;

  // ---- Phase 3: final reconciliation, exact numbers per show.
  for (const [showId, expected] of expectedConfirmed) {
    const r = await getShow(showId);
    if (r.status !== 200) {
      check(false, `reconcile ${expected.label}: GET /shows/${showId} -> ${r.status}`);
      continue;
    }
    const c = r.body['counts'];
    check(c.total_seats === expected.total, `reconcile ${expected.label}: total_seats ${c.total_seats} != ${expected.total}`);
    check(c.confirmed === expected.confirmed, `reconcile ${expected.label}: confirmed ${c.confirmed} != ${expected.confirmed}`);
    check(c.available === expected.total - expected.confirmed, `reconcile ${expected.label}: available ${c.available} != ${expected.total - expected.confirmed}`);
    check(c.held === 0, `reconcile ${expected.label}: held ${c.held} != 0`);
    check(
      r.body['seats'].filter((s: { status: string }) => s.status === 'confirmed').length === c.confirmed,
      `reconcile ${expected.label}: per-seat states disagree with counts`,
    );
  }

  // ---- Global assertions + report.
  const fiveXx = [...stats.byStatus.entries()].filter(([k]) => k.startsWith('5')).reduce((n, [, v]) => n + v, 0);
  const transportFailures = [...stats.transportErrors.values()].reduce((n, v) => n + v, 0);
  check(fiveXx === 0, `${fiveXx} responses were 5xx`);
  check(transportFailures === 0, `${transportFailures} transport failures/timeouts`);
  check(stats.byStatus.get('429') === undefined, 'received 429: an overload response does not pass the healthy-burst scenario');

  const total = [...stats.total].sort((a, b) => a - b);
  const wire = [...stats.wire].sort((a, b) => a - b);
  const line = (label: string, s: number[]) =>
    `  ${label.padEnd(26)} p50=${percentile(s, 50).toFixed(1)}  p95=${percentile(s, 95).toFixed(1)}  p99=${percentile(s, 99).toFixed(1)}  max=${(s[s.length - 1] ?? 0).toFixed(1)} ms`;

  const out: string[] = [];
  out.push('', '=== Burst report ===');
  const phase1Requests = COUNT + LIMIT_USERS * 10 + RETRY_GROUPS * (RETRY_SIZE + 1);
  const elapsedSeconds = (Date.now() - started) / 1000;
  out.push(`requests sent: ${stats.requests}   state polls: ${polls}   phase-1 burst: ${phase1Requests} requests released at one barrier in ${burstSeconds.toFixed(2)} s`);
  out.push(`THROUGHPUT: ${(phase1Requests / burstSeconds).toFixed(1)} req/s during the phase-1 burst   ${(stats.requests / elapsedSeconds).toFixed(1)} req/s over the whole run (setup, polls and phase 2 included)`);
  out.push(`peak in-flight (submitted, unanswered): ${stats.peakInFlight}   peak on-the-wire (holding a socket): ${stats.peakOnWire}   socket cap: ${SOCKETS}`);
  out.push('  (requests beyond the socket cap queue inside this client; in-flight counts them, on-the-wire does not)');
  out.push('status / reason distribution:');
  for (const [k, v] of [...stats.byStatus.entries()].sort()) out.push(`  ${k.padEnd(28)} ${v}`);
  if (stats.recovered > 0) out.push(`transport failures resolved by same-key retry: ${stats.recovered} (still counted as failures)`);
  out.push(`idempotent replays (200/409 with Idempotent-Replayed: true): ${stats.replays}`);
  out.push(`5xx: ${fiveXx}   transport failures/timeouts: ${transportFailures}${transportFailures ? ` ${JSON.stringify([...stats.transportErrors])}` : ''}`);
  out.push('latency:');
  out.push(line('submit -> response', total));
  out.push(line('socket -> response', wire));
  out.push(`reconciliation: ${expectedConfirmed.size} shows checked (available+held+confirmed=total, exact confirmed counts)`);
  out.push(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  out.push(violations.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${violations.length} violations)`);
  process.stdout.write(`${out.join('\n')}\n`);
  agent.destroy();
  pollAgent.destroy();
  process.exitCode = violations.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`burst aborted: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
