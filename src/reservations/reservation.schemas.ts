import { createHash } from 'node:crypto';
import { z } from 'zod';
import { seatLabel } from '../shows/show.schemas';

export const MAX_SEATS_PER_RESERVATION = 10;

export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'idempotency key must be 1-128 chars of [A-Za-z0-9._:-]');

/**
 * POST /shows/:id/reserve body. Unknown keys (e.g. a spoofed user_id) are stripped and never read:
 * identity comes only from the verified token. idempotency_key may instead arrive in the Idempotency-Key
 * header; the controller reconciles the two.
 */
export const reserveBody = z.object({
  seats: z
    .array(seatLabel)
    .min(1, 'seats must not be empty')
    .max(MAX_SEATS_PER_RESERVATION, `at most ${MAX_SEATS_PER_RESERVATION} seats per request`)
    .refine((seats) => new Set(seats).size === seats.length, 'seats must be unique'),
  idempotency_key: idempotencyKey.optional(),
});

export const reserveParams = z.object({ id: z.uuid() });

/** Stable sorted order (plain code-unit order == COLLATE "C" for our ASCII labels). */
export function canonicalSeats(seats: readonly string[]): string[] {
  return [...seats].sort();
}

/**
 * Fingerprint of the logical request. Two bodies with the same seat set in a different order hash the same
 * (documented contract). The user and key are not hashed: they are part of the idempotency row's primary key.
 */
export function requestFingerprint(showId: string, canonicalSeatList: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ show_id: showId, seats: canonicalSeatList })).digest('hex');
}
