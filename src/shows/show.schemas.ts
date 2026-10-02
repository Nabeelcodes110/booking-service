import { z } from 'zod';

export const MAX_SEATS_PER_SHOW = 10_000;
export const DEFAULT_PER_USER_LIMIT = 4;

export const seatLabel = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'seat label must be 1-32 chars of [A-Za-z0-9_-]');

/** POST /shows body. Unknown keys (e.g. a spoofed user_id) are stripped, never used. */
export const createShowBody = z.object({
  name: z.string().trim().min(1).max(200),
  seats: z
    .array(seatLabel)
    .min(1, 'seats must not be empty')
    .max(MAX_SEATS_PER_SHOW)
    .refine((seats) => new Set(seats).size === seats.length, 'seats must be unique'),
  // z.number().int() rejects floats, NaN/Infinity and values beyond Number.MAX_SAFE_INTEGER.
  price_paise: z.number().int().min(1).max(1_000_000_000),
  per_user_limit: z.number().int().min(1).max(100).optional(),
});
export type CreateShowInput = z.infer<typeof createShowBody>;

export const showIdParams = z.object({ id: z.uuid() });
