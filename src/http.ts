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
    log.error({ err, request_id: res.locals.requestId }, 'unhandled error');
    sendError(res, 500, 'internal_error', 'Internal server error');
  };
}
