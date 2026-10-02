import type { RequestHandler, Response } from 'express';
import { AppError } from '../errors';
import { parseOrThrow } from '../validation';
import { cancelParams, idempotencyKey, reserveBody, reserveParams } from './reservation.schemas';
import type { ReservationService, ReserveResult } from './reservation.service';

/** Thin HTTP layer: validate, call the service, map the result to status/headers/body. */
export class ReservationController {
  constructor(private readonly service: ReservationService) {}

  reserve: RequestHandler = async (req, res) => {
    const { id: showId } = parseOrThrow(reserveParams, req.params);
    const body = parseOrThrow(reserveBody, req.body);
    const key = resolveIdempotencyKey(req.header('idempotency-key'), body.idempotency_key);

    // Identity is the verified token subject. Any user_id in the body was already stripped by the schema.
    const userId = req.auth?.userId;
    if (!userId) throw new AppError(401, 'unauthorized', 'Authentication required');

    const result = await this.service.reserve({ userId, showId, idempotencyKey: key, seats: body.seats });
    sendResult(res, result);
  };

  cancel: RequestHandler = async (req, res) => {
    const { id: reservationId } = parseOrThrow(cancelParams, req.params);
    const userId = req.auth?.userId;
    if (!userId) throw new AppError(401, 'unauthorized', 'Authentication required');

    const { reservation_id, show_id, status } = await this.service.cancel({ userId, reservationId });
    // 200 for the first cancellation and for every repeat; the body never reveals which one it was.
    res.status(200).json({ reservation_id, show_id, status });
  };
}

/** Header and body keys may both be supplied but must agree; at least one is required. */
function resolveIdempotencyKey(header: string | undefined, bodyKey: string | undefined): string {
  const fromHeader = header === undefined ? undefined : parseOrThrow(idempotencyKey, header);
  if (fromHeader !== undefined && bodyKey !== undefined && fromHeader !== bodyKey) {
    throw new AppError(400, 'validation_error', 'Idempotency-Key header and idempotency_key body field differ');
  }
  const key = fromHeader ?? bodyKey;
  if (key === undefined) throw new AppError(400, 'validation_error', 'idempotency_key is required');
  return key;
}

function sendResult(res: Response, result: ReserveResult): void {
  if (result.replayed) {
    res.setHeader('Idempotent-Replayed', 'true');
    // A stored success (201) is replayed as 200 so a client can tell one new booking from its retries.
    // A stored decline keeps its original 409 and message.
    const status = result.status === 201 ? 200 : result.status;
    res.status(status).json(withRequestId(result.body, res));
    return;
  }
  res.status(result.status).json(withRequestId(result.body, res));
}

/** Declines are stored without a request_id (it belongs to the current request, not the original one). */
function withRequestId(body: object, res: Response): object {
  return 'error' in body ? { ...body, request_id: res.locals.requestId } : body;
}
