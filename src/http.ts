import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from './errors';
import type { Logger } from './logger';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Use a valid incoming X-Request-Id, otherwise generate one; echo it on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export function sendError(res: Parameters<RequestHandler>[1], status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message }, request_id: res.locals.requestId });
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, 'not_found', 'Route not found');
};

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
// 57014 query_canceled (statement timeout), 53300 too_many_connections, 57P01-03 admin/crash/cannot_connect_now
const PG_UNAVAILABLE_CODES = new Set(['57014', '53300', '57P01', '57P02', '57P03']);

/** Connection failures, pool wait timeouts and statement timeouts: infrastructure trouble, not a domain outcome. */
export function isDbUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: string; message?: string };
  if (code && (NETWORK_CODES.has(code) || PG_UNAVAILABLE_CODES.has(code) || code.startsWith('08'))) return true;
  return (
    typeof message === 'string' &&
    /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error/i.test(message)
  );
}

/** Single place that turns thrown errors into the stable envelope. Never leaks SQL or stack text. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    const type = (err as { type?: string } | null)?.type; // body-parser error types
    if (type === 'entity.too.large') {
      sendError(res, 413, 'payload_too_large', 'Request body is too large');
      return;
    }
    if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || type === 'charset.unsupported') {
      sendError(res, 400, 'validation_error', 'Request body is not valid JSON');
      return;
    }
    if (isDbUnavailable(err)) {
      // Fail closed and honestly: an outage or pool exhaustion is a 503, never a seat_taken decline.
      log.error({ err, request_id: res.locals.requestId }, 'database unavailable');
      sendError(res, 503, 'unavailable', 'Service temporarily unavailable');
      return;
    }
    log.error({ err, request_id: res.locals.requestId }, 'unhandled error');
    sendError(res, 500, 'internal_error', 'Internal server error');
  };
}
