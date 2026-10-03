import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, dbState, startHarness, type Harness, type Reply } from './helpers/harness';

/**
 * T08: correctness under concurrency, over real HTTP against real PostgreSQL (READ COMMITTED, the production
 * transaction code). Every test builds its own show, so tests never depend on each other's rows.
 */
let h: Harness;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  h = await startHarness();
  api = client(h);
});
afterAll(async () => {
  await h.close();
});

const count = (replies: Reply[], status: number) => replies.filter((r) => r.status === status).length;
const labels = (n: number, prefix = 'S') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** HTTP view and SQL tables must agree exactly, and quota counters must equal the seats actually owned. */
async function expectReconciled(showId: string) {
  const view = await api.getShow(showId);
  const { counts, seats } = view.body;
  expect(counts.available + counts.held + counts.confirmed).toBe(counts.total_seats);
  expect(counts.held).toBe(0);
  expect(seats.filter((s: { status: string }) => s.status === 'confirmed').length).toBe(counts.confirmed);

  const db = await dbState(h.pool, showId);
  expect(counts.confirmed).toBe(db.heldSeats);
  expect(counts.total_seats).toBe(db.totalSeats);
  expect(db.quota).toEqual(db.ownedSeats); // stored counter == active seat ownership, per user
}

describe('hot seat', () => {
  it('500 different users and keys on one seat: exactly one 201, 499 seat_taken 409, no 5xx', async () => {
    const showId = await api.createShow(['A1', 'A2']);
    const replies = await Promise.all(Array.from({ length: 5000 }, (_, i) => api.reserve(showId, `hot-${i}`, ['A1'], `k-${i}`)));

    expect(count(replies, 201)).toBe(1);
    expect(count(replies, 409)).toBe(4999);
    expect(replies.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(replies.filter((r) => r.status === 409).every((r) => r.body['error'].code === 'seat_taken')).toBe(true);
    const winner = replies.find((r) => r.status === 201);
    expect(winner?.body['status']).toBe('confirmed');
    expect(winner?.headers.get('idempotent-replayed')).toBeNull();

    const view = await api.getShow(showId);
    expect(view.body['counts']).toEqual({ available: 1, held: 0, confirmed: 1, total_seats: 2 });
    await expectReconciled(showId);
  });
});

describe('per-user limit', () => {
  it('one user, 10 parallel requests on distinct seats, limit 4: exactly 4 active seats, the rest per_user_limit', async () => {
    const showId = await api.createShow(labels(10));
    const seats = labels(10);
    const replies = await Promise.all(seats.map((s, i) => api.reserve(showId, 'greedy', [s], `g-${i}`)));

    expect(count(replies, 201)).toBe(4);
    expect(count(replies, 409)).toBe(6);
    expect(replies.filter((r) => r.status === 409).every((r) => r.body['error'].code === 'per_user_limit')).toBe(true);
    expect((await dbState(h.pool, showId)).quota).toEqual({ greedy: 4 });
    await expectReconciled(showId);
  });

  it('honours a custom per_user_limit and frees quota on cancellation', async () => {
    const showId = await api.createShow(labels(4), { per_user_limit: 1 });
    const first = await api.reserve(showId, 'u', ['S1'], 'a');
    expect(first.status).toBe(201);
    expect((await api.reserve(showId, 'u', ['S2'], 'b')).body['error'].code).toBe('per_user_limit');
    expect((await api.cancel(first.body['reservation_id'], 'u')).status).toBe(200);
    expect((await api.reserve(showId, 'u', ['S2'], 'c')).status).toBe(201);
    await expectReconciled(showId);
  });
});

describe('idempotency', () => {
  it('same key, concurrent identical body: one new booking, identical reservation and amount on every replay', async () => {
    const showId = await api.createShow(labels(3), { price_paise: 12345 });
    const replies = await Promise.all(Array.from({ length: 30 }, () => api.reserve(showId, 'dup', ['S1', 'S2'], 'same-key')));

    expect(count(replies, 201)).toBe(1);
    expect(count(replies, 200)).toBe(29);
    const created = replies.find((r) => r.status === 201)!;
    for (const r of replies.filter((x) => x.status === 200)) {
      expect(r.headers.get('idempotent-replayed')).toBe('true');
      expect(r.body['reservation_id']).toBe(created.body['reservation_id']);
      expect(r.body['amount_paise']).toBe(24690);
    }
    expect((await dbState(h.pool, showId)).confirmedReservations).toBe(1);
    await expectReconciled(showId);
  });

  it('same key with different seats is idempotency_conflict; a reordered seat set is the same body', async () => {
    const showId = await api.createShow(labels(4));
    const first = await api.reserve(showId, 'u', ['S2', 'S1'], 'k');
    expect(first.status).toBe(201);

    const conflict = await api.reserve(showId, 'u', ['S1', 'S3'], 'k');
    expect(conflict.status).toBe(409);
    expect(conflict.body['error'].code).toBe('idempotency_conflict');

    const reordered = await api.reserve(showId, 'u', ['S1', 'S2'], 'k');
    expect(reordered.status).toBe(200);
    expect(reordered.body['reservation_id']).toBe(first.body['reservation_id']);
    await expectReconciled(showId);
  });

  it('header and body key must agree; the header alone is accepted', async () => {
    const showId = await api.createShow(labels(2));
    const token = h.token('u');
    const post = (body: unknown, key: string) =>
      fetch(`${h.baseUrl}/shows/${showId}/reserve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    expect((await post({ seats: ['S1'], idempotency_key: 'other' }, 'hdr')).status).toBe(400);
    expect((await post({ seats: ['S1'] }, 'hdr')).status).toBe(201);
  });

  it('replay after cancellation returns the original result and never rebooks the seat', async () => {
    const showId = await api.createShow(labels(2));
    const first = await api.reserve(showId, 'u', ['S1'], 'k');
    await api.cancel(first.body['reservation_id'], 'u');

    const replay = await api.reserve(showId, 'u', ['S1'], 'k');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body['reservation_id']).toBe(first.body['reservation_id']);
    expect((await api.getShow(showId)).body['counts']).toEqual({ available: 2, held: 0, confirmed: 0, total_seats: 2 });
    await expectReconciled(showId);
  });

  it('a stored decline keeps replaying even after the seat becomes available', async () => {
    const showId = await api.createShow(labels(2));
    const held = await api.reserve(showId, 'owner', ['S1'], 'o');
    const declined = await api.reserve(showId, 'late', ['S1'], 'late-key');
    expect(declined.status).toBe(409);

    await api.cancel(held.body['reservation_id'], 'owner');
    const replay = await api.reserve(showId, 'late', ['S1'], 'late-key');
    expect(replay.status).toBe(409);
    expect(replay.body['error'].code).toBe('seat_taken');
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await api.reserve(showId, 'late', ['S1'], 'fresh-key')).status).toBe(201); // a new key is a new attempt
    await expectReconciled(showId);
  });

  it('process restart and lost response: the same key replays from PostgreSQL, no second booking', async () => {
    const showId = await api.createShow(labels(2));
    const first = await api.reserve(showId, 'u', ['S1'], 'survives-restart');
    expect(first.status).toBe(201);

    // New process-equivalent: fresh pool, fresh app, no shared memory with the first one.
    const restarted = await startHarness();
    try {
      const retry = await client(restarted).reserve(showId, 'u', ['S1'], 'survives-restart');
      expect(retry.status).toBe(200);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect((await dbState(restarted.pool, showId)).confirmedReservations).toBe(1);
    } finally {
      await restarted.close();
    }
  });
});

describe('multi-seat all-or-nothing', () => {
  it('overlapping sets requested in reversed order: no deadlock leak, no partial booking', async () => {
    const showId = await api.createShow(labels(6));
    const forward = ['S1', 'S2', 'S3', 'S4'];
    const reversed = ['S6', 'S5', 'S4', 'S3', 'S2'];
    const replies = await Promise.all(
      Array.from({ length: 60 }, (_, i) => api.reserve(showId, `m-${i}`, i % 2 ? [...forward].reverse() : reversed, `k-${i}`)),
    );

    expect(replies.filter((r) => r.status >= 500)).toHaveLength(0);
    // sets overlap on S2-S4, so at most one request can win
    expect(count(replies, 201)).toBe(1);
    expect(count(replies, 409)).toBe(59);
    const winner = replies.find((r) => r.status === 201)!;
    const view = await api.getShow(showId);
    expect(view.body['counts'].confirmed).toBe(winner.body['seats'].length); // all of its seats, none of anyone else's
    // every loser consumed no quota
    const quota = (await dbState(h.pool, showId)).quota;
    expect(quota).toEqual({ [winner.body['user_id']]: winner.body['seats'].length });
    await expectReconciled(showId);
  });

  it('a request touching one occupied seat declines entirely and consumes no quota', async () => {
    const showId = await api.createShow(labels(3));
    expect((await api.reserve(showId, 'a', ['S2'], 'a')).status).toBe(201);

    const declined = await api.reserve(showId, 'b', ['S3', 'S2', 'S1'], 'b');
    expect(declined.status).toBe(409);
    expect(declined.body['error'].code).toBe('seat_taken');
    expect((await api.getShow(showId)).body['counts'].confirmed).toBe(1);
    expect((await dbState(h.pool, showId)).quota).toEqual({ a: 1 });

    // b still has its full quota afterwards
    expect((await api.reserve(showId, 'b', ['S1', 'S3'], 'b2')).status).toBe(201);
    await expectReconciled(showId);
  });

  it('disjoint requests from many users all succeed concurrently (no global lock needed)', async () => {
    const showId = await api.createShow(labels(40));
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => api.reserve(showId, `d-${i}`, [`S${2 * i + 1}`, `S${2 * i + 2}`], `k-${i}`)));
    expect(count(replies, 201)).toBe(20);
    expect((await api.getShow(showId)).body['counts']).toEqual({ available: 0, held: 0, confirmed: 40, total_seats: 40 });
    await expectReconciled(showId);
  });
});

describe('identity and ownership', () => {
  it('a spoofed body user_id is ignored: the reservation belongs to the token subject', async () => {
    const showId = await api.createShow(labels(2));
    const r = await api.reserve(showId, 'attacker', ['S1'], 'k', { user_id: 'victim' });
    expect(r.status).toBe(201);
    expect(r.body['user_id']).toBe('attacker');
    expect((await dbState(h.pool, showId)).quota).toEqual({ attacker: 1 });
  });

  it("a foreign user cannot cancel someone else's reservation", async () => {
    const showId = await api.createShow(labels(2));
    const r = await api.reserve(showId, 'owner', ['S1'], 'k');
    const foreign = await api.cancel(r.body['reservation_id'], 'intruder');
    expect(foreign.status).toBe(403);
    expect(foreign.body['error'].code).toBe('forbidden');
    expect((await api.getShow(showId)).body['counts'].confirmed).toBe(1);
    await expectReconciled(showId);
  });

  it('missing or invalid tokens get 401 before any booking work', async () => {
    const showId = await api.createShow(labels(1));
    const res = await fetch(`${h.baseUrl}/shows/${showId}/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' },
      body: JSON.stringify({ seats: ['S1'], idempotency_key: 'k' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('cancellation races', () => {
  it('concurrent repeated cancels release the quota exactly once', async () => {
    const showId = await api.createShow(labels(4));
    const r = await api.reserve(showId, 'u', ['S1', 'S2'], 'k');
    await api.reserve(showId, 'u', ['S3'], 'k2'); // quota is 3 before the cancels

    const cancels = await Promise.all(Array.from({ length: 15 }, () => api.cancel(r.body['reservation_id'], 'u')));
    expect(cancels.every((c) => c.status === 200 && c.body['status'] === 'cancelled')).toBe(true);
    expect((await dbState(h.pool, showId)).quota).toEqual({ u: 1 }); // 3 - 2, not 3 - 30
    await expectReconciled(showId);
  });

  it('an old cancel repeated after the seat was rebooked does not clear the new owner', async () => {
    const showId = await api.createShow(labels(1));
    const first = await api.reserve(showId, 'first', ['S1'], 'f');
    await api.cancel(first.body['reservation_id'], 'first');
    const second = await api.reserve(showId, 'second', ['S1'], 's');
    expect(second.status).toBe(201);

    expect((await api.cancel(first.body['reservation_id'], 'first')).status).toBe(200); // stale repeat
    expect((await api.getShow(showId)).body['counts']).toEqual({ available: 0, held: 0, confirmed: 1, total_seats: 1 });
    expect((await dbState(h.pool, showId)).quota).toEqual({ second: 1 });
    await expectReconciled(showId);
  });

  it('cancel racing with new reservations by the same user and by others keeps every invariant', async () => {
    const showId = await api.createShow(labels(8), { per_user_limit: 2 });
    const mine = await Promise.all([api.reserve(showId, 'u', ['S1'], 'a'), api.reserve(showId, 'u', ['S2'], 'b')]);
    expect(count(mine, 201)).toBe(2);

    const racers = await Promise.all([
      api.cancel(mine[0].body['reservation_id'], 'u'),
      api.cancel(mine[1].body['reservation_id'], 'u'),
      api.reserve(showId, 'u', ['S3'], 'c'),
      api.reserve(showId, 'u', ['S4'], 'd'),
      api.reserve(showId, 'other', ['S1'], 'e'),
      api.reserve(showId, 'other', ['S2'], 'f'),
      api.reserve(showId, 'third', ['S1', 'S2'], 'g'),
    ]);
    expect(racers.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(racers.slice(0, 2).every((r) => r.status === 200)).toBe(true);
    const db = await dbState(h.pool, showId);
    expect(Object.values(db.quota).every((n) => n <= 2)).toBe(true);
    await expectReconciled(showId);
  });
});

describe('snapshot reads under load', () => {
  it('GET /shows/:id always satisfies available + held + confirmed = total_seats while reservations and cancels run', async () => {
    const showId = await api.createShow(labels(60), { per_user_limit: 3 });
    let running = true;
    const violations: unknown[] = [];
    const poller = (async () => {
      while (running) {
        const { body } = await api.getShow(showId);
        const c = body['counts'];
        const confirmedRows = body['seats'].filter((s: { status: string }) => s.status === 'confirmed').length;
        if (c.available + c.held + c.confirmed !== c.total_seats || c.confirmed !== confirmedRows) violations.push(c);
      }
    })();

    const work = Array.from({ length: 120 }, async (_, i) => {
      const user = `load-${i % 30}`;
      const r = await api.reserve(showId, user, [`S${(i % 60) + 1}`], `k-${i}`);
      if (r.status === 201 && i % 3 === 0) await api.cancel(r.body['reservation_id'], user);
      return r;
    });
    const replies = await Promise.all(work);
    running = false;
    await poller;

    expect(replies.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(violations).toEqual([]);
    await expectReconciled(showId);
  });
});
