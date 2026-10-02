import type { PoolClient } from 'pg';
import { toSafeInt } from '../db/pool';

export interface StoredOutcome {
  fingerprint: string;
  status_code: number;
  response: Record<string, unknown>;
}

export interface ReservationRow {
  id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  status: 'confirmed' | 'cancelled';
}

export interface SeatLockRow {
  seat_id: string;
  reservation_id: string | null;
}

/**
 * SQL only. Every method takes the caller's transaction client; the service owns BEGIN/COMMIT and the
 * lock order: idempotency claim -> user quota row -> seat rows ascending (cancel: quota -> seats -> reservation).
 */
export class ReservationRepository {
  /** Immutable show configuration. No lock needed: shows are never updated (trigger-enforced). */
  async findShowConfig(db: PoolClient, showId: string): Promise<{ pricePaise: number; perUserLimit: number } | null> {
    const { rows } = await db.query<{ price_paise: string; per_user_limit: number }>(
      'SELECT price_paise, per_user_limit FROM shows WHERE id = $1',
      [showId],
    );
    return rows[0] ? { pricePaise: toSafeInt(rows[0].price_paise), perUserLimit: rows[0].per_user_limit } : null;
  }

  /**
   * Step 2: claim the (user, show, key) slot. If another transaction is claiming the same key, this INSERT
   * blocks until that transaction commits or rolls back (unique-index wait). Returns true when WE own the claim.
   */
  async claimIdempotencyKey(db: PoolClient, userId: string, showId: string, key: string, fingerprint: string): Promise<boolean> {
    const res = await db.query(
      `INSERT INTO idempotency_requests (user_id, show_id, key, fingerprint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, show_id, key) DO NOTHING`,
      [userId, showId, key, fingerprint],
    );
    return res.rowCount === 1;
  }

  /** The committed row that beat us to the key (READ COMMITTED sees it once the winner has committed). */
  async findStoredOutcome(db: PoolClient, userId: string, showId: string, key: string): Promise<StoredOutcome | null> {
    const { rows } = await db.query<StoredOutcome>(
      `SELECT fingerprint, status_code, response
         FROM idempotency_requests
        WHERE user_id = $1 AND show_id = $2 AND key = $3 AND status_code IS NOT NULL`,
      [userId, showId, key],
    );
    return rows[0] ?? null;
  }

  /** Step 3: make sure the quota row exists, then take its row lock. Returns the current active seat count. */
  async lockUserQuota(db: PoolClient, userId: string, showId: string): Promise<number> {
    await db.query(
      `INSERT INTO user_show_usage (show_id, user_id) VALUES ($1, $2)
       ON CONFLICT (show_id, user_id) DO NOTHING`,
      [showId, userId],
    );
    const { rows } = await db.query<{ active_count: number }>(
      'SELECT active_count FROM user_show_usage WHERE show_id = $1 AND user_id = $2 FOR UPDATE',
      [showId, userId],
    );
    return rows[0]!.active_count;
  }

  /**
   * Step 4: lock ONLY the requested seats, one statement, in ascending label order.
   * PostgreSQL applies ORDER BY before row locking (plan: LockRows over Sort), so locks are acquired in
   * the same order by every request; COLLATE "C" makes that order independent of database collation.
   * Seats that do not exist for the show are simply absent from the result.
   */
  async lockSeats(db: PoolClient, showId: string, seatIds: string[]): Promise<SeatLockRow[]> {
    const { rows } = await db.query<SeatLockRow>(
      `SELECT seat_id, reservation_id
         FROM show_seats
        WHERE show_id = $1 AND seat_id = ANY($2::text[])
        ORDER BY seat_id COLLATE "C"
          FOR UPDATE`,
      [showId, seatIds],
    );
    return rows;
  }

  async insertReservation(
    db: PoolClient,
    r: { showId: string; userId: string; seats: string[]; amountPaise: number },
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO reservations (show_id, user_id, seats, amount_paise)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [r.showId, r.userId, r.seats, r.amountPaise],
    );
    return rows[0]!.id;
  }

  /** Conditional allocation: only seats still free are taken; the caller asserts the changed-row count. */
  async assignSeats(db: PoolClient, showId: string, seatIds: string[], reservationId: string): Promise<number> {
    const res = await db.query(
      `UPDATE show_seats SET reservation_id = $3
        WHERE show_id = $1 AND seat_id = ANY($2::text[]) AND reservation_id IS NULL`,
      [showId, seatIds, reservationId],
    );
    return res.rowCount ?? 0;
  }

  async addToQuota(db: PoolClient, userId: string, showId: string, seatCount: number): Promise<void> {
    await db.query(
      'UPDATE user_show_usage SET active_count = active_count + $3 WHERE show_id = $1 AND user_id = $2',
      [showId, userId, seatCount],
    );
  }

  /** Persist the original outcome on the claimed row; commits atomically with the booking (or the decline). */
  async saveOutcome(
    db: PoolClient,
    o: { userId: string; showId: string; key: string; statusCode: number; response: object; reservationId: string | null },
  ): Promise<void> {
    await db.query(
      `UPDATE idempotency_requests
          SET status_code = $4, response = $5, reservation_id = $6
        WHERE user_id = $1 AND show_id = $2 AND key = $3`,
      [o.userId, o.showId, o.key, o.statusCode, JSON.stringify(o.response), o.reservationId],
    );
  }

  /** Immutable facts (owner, show, seats) plus the current status. Unlocked: only used to pick the quota lock. */
  async findReservation(db: PoolClient, reservationId: string): Promise<ReservationRow | null> {
    const { rows } = await db.query<ReservationRow>(
      'SELECT id, show_id, user_id, seats, status FROM reservations WHERE id = $1',
      [reservationId],
    );
    return rows[0] ?? null;
  }

  /** Lifecycle re-read. Called only while holding the owner's quota lock, which serializes cancels of this reservation. */
  async findStatus(db: PoolClient, reservationId: string): Promise<'confirmed' | 'cancelled' | null> {
    const { rows } = await db.query<{ status: 'confirmed' | 'cancelled' }>(
      'SELECT status FROM reservations WHERE id = $1',
      [reservationId],
    );
    return rows[0]?.status ?? null;
  }

  /** confirmed -> cancelled exactly once; returns false if it was not confirmed. */
  async markCancelled(db: PoolClient, reservationId: string): Promise<boolean> {
    const res = await db.query(
      "UPDATE reservations SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'confirmed'",
      [reservationId],
    );
    return res.rowCount === 1;
  }

  /**
   * Free seats ONLY where they still point at this reservation. A stale cancel can therefore never clear a
   * seat that has since been rebooked under a different reservation.
   */
  async releaseSeats(db: PoolClient, showId: string, seatIds: string[], reservationId: string): Promise<number> {
    const res = await db.query(
      `UPDATE show_seats SET reservation_id = NULL
        WHERE show_id = $1 AND seat_id = ANY($2::text[]) AND reservation_id = $3`,
      [showId, seatIds, reservationId],
    );
    return res.rowCount ?? 0;
  }

  async subtractFromQuota(db: PoolClient, userId: string, showId: string, seatCount: number): Promise<void> {
    await db.query(
      'UPDATE user_show_usage SET active_count = active_count - $3 WHERE show_id = $1 AND user_id = $2',
      [showId, userId, seatCount],
    );
  }
}
