import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from './config';
import { AppError } from './errors';

export interface AuthContext {
  /** Verified `sub` claim. The ONLY source of user identity; request bodies are never trusted for it. */
  userId: string;
  /** True only when the verified token carries role === 'admin'. */
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

type JwtSettings = Pick<Config, 'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE'>;

const ALGORITHM = 'HS256';
const MAX_SUB_LENGTH = 128;
const MAX_TTL_SECONDS = 7 * 24 * 3600;

/** Verify signature, algorithm (HS256 only), exp (required), issuer and audience. Throws 401 on any failure. */
export function verifyToken(token: string, cfg: JwtSettings): AuthContext {
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, cfg.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: cfg.JWT_ISSUER,
      audience: cfg.JWT_AUDIENCE,
    });
    if (typeof decoded === 'string') throw new Error('unexpected string payload');
    payload = decoded;
  } catch {
    throw new AppError(401, 'unauthorized', 'Invalid or expired token');
  }
  // jsonwebtoken only checks exp when present; tokens that never expire are refused.
  if (typeof payload.exp !== 'number') throw new AppError(401, 'unauthorized', 'Invalid or expired token');
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUB_LENGTH) {
    throw new AppError(401, 'unauthorized', 'Invalid or expired token');
  }
  return { userId: sub, isAdmin: payload['role'] === 'admin' };
}

/** Sign a token. Used only by the offline CLI and tests; there is deliberately no HTTP route that calls this. */
export function signToken(
  opts: { sub: string; admin?: boolean; ttlSeconds?: number },
  cfg: JwtSettings,
): string {
  const ttl = opts.ttlSeconds ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`);
  }
  if (opts.sub.length === 0 || opts.sub.length > MAX_SUB_LENGTH) throw new RangeError('sub must be 1-128 characters');
  return jwt.sign(opts.admin ? { role: 'admin' } : {}, cfg.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: opts.sub,
    issuer: cfg.JWT_ISSUER,
    audience: cfg.JWT_AUDIENCE,
    expiresIn: ttl,
  });
}

function bearer(header: string | undefined): string {
  const match = header ? /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header) : null;
  if (!match?.[1]) throw new AppError(401, 'unauthorized', 'Missing or malformed Authorization header');
  return match[1];
}

/** Express middleware factories. Handlers read req.auth.userId, never the body. */
export function authMiddleware(cfg: JwtSettings) {
  const requireUser: RequestHandler = (req, _res, next) => {
    try {
      req.auth = verifyToken(bearer(req.header('authorization')), cfg);
      next();
    } catch (err) {
      next(err);
    }
  };
  const requireAdmin: RequestHandler = (req, res, next) => {
    requireUser(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!req.auth?.isAdmin) return next(new AppError(403, 'forbidden', 'Admin role required'));
      next();
    });
  };
  return { requireUser, requireAdmin };
}
