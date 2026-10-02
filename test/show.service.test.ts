import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import type { SeatRow, ShowRepository, ShowRow } from '../src/shows/show.repository';
import { ShowService } from '../src/shows/show.service';

const SHOW: ShowRow = { id: '11111111-1111-4111-8111-111111111111', name: 'Evening', price_paise: 25000, per_user_limit: 4 };

/** A pool whose single client records every SQL statement the transaction wrapper sends. */
function fakePool() {
  const statements: string[] = [];
  const client = {
    query: vi.fn((sql: string) => {
      statements.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(() => Promise.resolve(client as unknown as PoolClient)) } as unknown as Pool;
  return { pool, client, statements };
}

function fakeRepo(overrides: Partial<Record<keyof ShowRepository, unknown>> = {}) {
  return {
    insertShow: vi.fn((_db: PoolClient, s: { name: string; pricePaise: number; perUserLimit: number }) =>
      Promise.resolve({ ...SHOW, name: s.name, price_paise: s.pricePaise, per_user_limit: s.perUserLimit }),
    ),
    insertSeats: vi.fn(() => Promise.resolve()),
    findShow: vi.fn(() => Promise.resolve(SHOW)),
    listSeats: vi.fn(() => Promise.resolve([] as SeatRow[])),
    ...overrides,
  } as unknown as ShowRepository & { [K in keyof ShowRepository]: ReturnType<typeof vi.fn> };
}

describe('ShowService.createShow', () => {
  it('inserts the show and its sorted seats in one committed transaction and returns all seats available', async () => {
    const { pool, statements, client } = fakePool();
    const repo = fakeRepo();
    const view = await new ShowService(pool, repo).createShow({ name: 'Evening', seats: ['B1', 'A2', 'A1'], price_paise: 25000 });

    expect(repo.insertSeats).toHaveBeenCalledWith(client, SHOW.id, ['A1', 'A2', 'B1']);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(view.seats).toEqual([
      { seat_id: 'A1', status: 'available' },
      { seat_id: 'A2', status: 'available' },
      { seat_id: 'B1', status: 'available' },
    ]);
    expect(view.counts).toEqual({ available: 3, held: 0, confirmed: 0, total_seats: 3 });
  });

  it('defaults per_user_limit to 4 and honours an explicit value', async () => {
    const { pool } = fakePool();
    const repo = fakeRepo();
    const service = new ShowService(pool, repo);

    expect((await service.createShow({ name: 'a', seats: ['A1'], price_paise: 1 })).per_user_limit).toBe(4);
    expect((await service.createShow({ name: 'a', seats: ['A1'], price_paise: 1, per_user_limit: 7 })).per_user_limit).toBe(7);
  });

  it('rolls back and releases the client when seat insertion fails, so no half-created show survives', async () => {
    const { pool, statements, client } = fakePool();
    const repo = fakeRepo({ insertSeats: vi.fn(() => Promise.reject(new Error('boom'))) });

    await expect(new ShowService(pool, repo).createShow({ name: 'a', seats: ['A1'], price_paise: 1 })).rejects.toThrow('boom');
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('ShowService.getShow', () => {
  it('reads inside one REPEATABLE READ read-only transaction', async () => {
    const { pool, statements } = fakePool();
    await new ShowService(pool, fakeRepo()).getShow(SHOW.id);

    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('derives statuses and counts from the same seat rows so they always reconcile', async () => {
    const { pool } = fakePool();
    const seats: SeatRow[] = [
      { seat_id: 'A1', reservation_id: null },
      { seat_id: 'A2', reservation_id: '22222222-2222-4222-8222-222222222222' },
      { seat_id: 'A3', reservation_id: null },
      { seat_id: 'A4', reservation_id: '33333333-3333-4333-8333-333333333333' },
    ];
    const view = await new ShowService(pool, fakeRepo({ listSeats: vi.fn(() => Promise.resolve(seats)) })).getShow(SHOW.id);

    expect(view.seats.map((s) => s.status)).toEqual(['available', 'confirmed', 'available', 'confirmed']);
    expect(view.counts).toEqual({ available: 2, held: 0, confirmed: 2, total_seats: 4 });
    const { available, held, confirmed, total_seats } = view.counts;
    expect(available + held + confirmed).toBe(total_seats);
  });

  it('throws 404 not_found for an unknown show and still releases the client', async () => {
    const { pool, client, statements } = fakePool();
    const service = new ShowService(pool, fakeRepo({ findShow: vi.fn(() => Promise.resolve(null)) }));

    const err = await service.getShow(SHOW.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
    expect(statements).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
