/** Domain/HTTP error carrying the stable envelope fields (see docs/API.md). */
export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'seat_taken'
  | 'per_user_limit'
  | 'idempotency_conflict'
  | 'payload_too_large'
  | 'internal_error'
  | 'unavailable';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
