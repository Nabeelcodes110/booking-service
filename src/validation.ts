import type { ZodType } from 'zod';
import { AppError } from './errors';

/** Parse untrusted input with a Zod schema; any failure becomes a 400 validation_error (no internals leaked). */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw new AppError(400, 'validation_error', problems);
}
