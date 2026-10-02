import type { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { AppError } from '../errors';
import { canonicalSeats, requestFingerprint } from './reservation.schemas';
import type { ReservationRepository } from './reservation.repository';

export interface ReservationBody {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: 'confirmed';
}

/** What the controller needs to answer the HTTP request. `body` is exactly what was stored for the key. */
export type ReserveResult =
  | { kind: 'confirmed'; status: 201; body: ReservationBody; replayed: false }
  | { kind: 'declined'; status: 409; reason: 'seat_taken' | 'per_user_limit'; body: DeclineBody; replayed: false }
  | { kind: 'replay'; status: number; body: Record<string, unknown>; replayed: true };

export interface DeclineBody extends Record<string, unknown> {
  error: { code: 'seat_taken' | 'per_user_limit'; message: string };
}

const DECLINE_MESSAGES = {
  seat_taken: 'One or more requested seats are not available',
  per_user_limit: 'Per-user seat limit for this show would be exceeded',
} as const;

export interface CancelResult {
  reservation_id: string;
  show_id: string;
  status: 'cancelled';
  /** True when this call was a repeat (no state change). Not part of the HTTP body. */
  alreadyCancelled: boolean;
}

export interface ReserveInput {
  userId: string;
  showId: string;
  idempotencyKey: string;
  seats: string[];
}

export class ReservationService {
  constructor(
    private readonly pool: Pool,
    private readonly repo: ReservationRepository,
    private readonly hooks: { onRetry?: (attempt: number, err: unknown) => void } = {},
  ) {}

  /**
   * One PostgreSQL transaction on one client. Lock order (also used by cancel): idempotency claim -> this
   * user's quota row -> requested seat rows ascending. Nothing here calls the network.
   *
   * Deadlock/serialization failures re-run this whole function (bounded, see withTransaction). If the
   * client never sees the response (crash, timeout), it retries the SAME idempotency key and gets the
   * stored outcome back instead of booking again.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const seats = canonicalSeats(input.seats);
    const fingerprint = requestFingerprint(input.showId, seats);
    const { userId, showId, idempotencyKey: key } = input;

    return withTransaction(
      this.pool,
      async (db): Promise<ReserveResult> => {
        // Step 1: immutable show config -> bounded integer total.
        const show = await this.repo.findShowConfig(db, showId);
        if (!show) throw new AppError(404, 'not_found', 'Show not found'); // nothing claimed, nothing stored
        const amountPaise = show.pricePaise * seats.length;
        if (!Number.isSafeInteger(amountPaise)) {
          throw new AppError(400, 'validation_error', 'Total amount exceeds the supported range');
        }

        // Step 2: idempotency claim. A concurrent request with the same key blocks here until we commit.
        const owned = await this.repo.claimIdempotencyKey(db, userId, showId, key, fingerprint);
        if (!owned) {
          const stored = await this.repo.findStoredOutcome(db, userId, showId, key);
          if (!stored) throw new Error('idempotency row vanished after conflict'); // retried by caller as unexpected
          if (stored.fingerprint !== fingerprint) {
            // Not stored: it is a client error about the key, not an outcome of ours.
            throw new AppError(409, 'idempotency_conflict', 'Idempotency key was already used with a different request');
          }
          return { kind: 'replay', status: stored.status_code, body: stored.response, replayed: true };
        }

        // Step 3: quota. Row lock serializes all of THIS user's reserve/cancel calls for this show.
        const active = await this.repo.lockUserQuota(db, userId, showId);
        if (active + seats.length > show.perUserLimit) {
          return this.decline(db, input, 'per_user_limit');
        }

        // Step 4: lock only the requested seats, ascending. Missing or occupied -> decline the whole request.
        const locked = await this.repo.lockSeats(db, showId, seats);
        if (locked.length !== seats.length || locked.some((s) => s.reservation_id !== null)) {
          return this.decline(db, input, 'seat_taken');
        }

        // Step 5: allocate. The conditional UPDATE must change exactly the requested rows or we abort.
        const reservationId = await this.repo.insertReservation(db, { showId, userId, seats, amountPaise });
        const changed = await this.repo.assignSeats(db, showId, seats, reservationId);
        if (changed !== seats.length) {
          throw new Error(`seat allocation changed ${changed} rows, expected ${seats.length}`); // rolls back
        }
        await this.repo.addToQuota(db, userId, showId, seats.length);

        const body: ReservationBody = {
          reservation_id: reservationId,
          show_id: showId,
          user_id: userId,
          seats,
          amount_paise: amountPaise,
          status: 'confirmed',
        };
        await this.repo.saveOutcome(db, { userId, showId, key, statusCode: 201, response: body, reservationId });
        return { kind: 'confirmed', status: 201, body, replayed: false };
      },
      this.hooks.onRetry ? { onRetry: this.hooks.onRetry } : {},
    );
  }

  /**
   * Owner-only cancellation. Same lock order as reserve, minus the idempotency claim:
   * owner's quota row -> seat rows ascending -> reservation state update.
   * (Reservation rows are never locked before the quota row, so cancel and reserve cannot deadlock.)
   *
   * Repeating a cancel is a successful no-op: the lifecycle is re-read under the quota lock, and an already
   * cancelled reservation returns before touching seats or quota. That is also why a stale cancel can never
   * clear seats that were rebooked under a new reservation.
   */
  async cancel(input: { userId: string; reservationId: string }): Promise<CancelResult> {
    return withTransaction(
      this.pool,
      async (db): Promise<CancelResult> => {
        // Immutable facts, read without a lock only to learn who owns it and which quota row to lock.
        const found = await this.repo.findReservation(db, input.reservationId);
        if (!found) throw new AppError(404, 'not_found', 'Reservation not found');
        if (found.user_id !== input.userId) throw new AppError(403, 'forbidden', 'Only the reservation owner can cancel it');
        const result = { reservation_id: found.id, show_id: found.show_id, status: 'cancelled' as const };

        // Step 1: quota lock first (serializes this user's reserve/cancel calls for the show).
        await this.repo.lockUserQuota(db, found.user_id, found.show_id);

        // Step 2: re-read lifecycle under the lock. Already cancelled -> idempotent success, nothing changes.
        const status = await this.repo.findStatus(db, found.id);
        if (status === 'cancelled') return { ...result, alreadyCancelled: true };
        if (status !== 'confirmed') throw new AppError(404, 'not_found', 'Reservation not found');

        // Step 3: lock the reservation's seats ascending, then transition once.
        await this.repo.lockSeats(db, found.show_id, found.seats);
        if (!(await this.repo.markCancelled(db, found.id))) throw new Error('reservation was not confirmed under lock');

        // Step 4: clear only seats still owned by THIS reservation; first cancellation must find all of them.
        const released = await this.repo.releaseSeats(db, found.show_id, found.seats, found.id);
        if (released !== found.seats.length) {
          throw new Error(`cancel released ${released} seats, expected ${found.seats.length}`); // rolls back
        }
        await this.repo.subtractFromQuota(db, found.user_id, found.show_id, found.seats.length);
        return { ...result, alreadyCancelled: false };
      },
      this.hooks.onRetry ? { onRetry: this.hooks.onRetry } : {},
    );
  }

  /**
   * Step 6: an expected domain decline is persisted on the claimed idempotency row and COMMITTED with no
   * seat or quota change. The same key keeps replaying this decline even if availability changes later.
   */
  private async decline(
    db: Parameters<ReservationRepository['saveOutcome']>[0],
    input: ReserveInput,
    reason: 'seat_taken' | 'per_user_limit',
  ): Promise<ReserveResult> {
    const body: DeclineBody = { error: { code: reason, message: DECLINE_MESSAGES[reason] } };
    await this.repo.saveOutcome(db, {
      userId: input.userId,
      showId: input.showId,
      key: input.idempotencyKey,
      statusCode: 409,
      response: body,
      reservationId: null,
    });
    return { kind: 'declined', status: 409, reason, body, replayed: false };
  }
}
