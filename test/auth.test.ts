import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../src/auth';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost/db',
  JWT_SECRET: 's'.repeat(40),
  JWT_ISSUER: 'booking-service',
  JWT_AUDIENCE: 'booking-api',
  LOG_LEVEL: 'silent',
});
const claims = { iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE, sub: 'alice' };
const forge = (payload: object, secret = config.JWT_SECRET, opts: jwt.SignOptions = {}) =>
  jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: 60, ...opts });

type Body = { error: { code: string }; request_id: string; user_id?: string; body_user_id_seen?: unknown };
const json = (r: Response) => r.json() as Promise<Body>;

describe('verifyToken', () => {
  it('accepts a valid user token and derives identity from sub', () => {
    expect(verifyToken(signToken({ sub: 'alice' }, config), config)).toEqual({ userId: 'alice', isAdmin: false });
  });

  it('grants admin only from the verified role claim', () => {
    expect(verifyToken(signToken({ sub: 'root', admin: true }, config), config).isAdmin).toBe(true);
    expect(verifyToken(forge({ ...claims, role: 'user' }), config).isAdmin).toBe(false);
    expect(verifyToken(forge({ ...claims, admin: true, is_admin: true, roles: ['admin'] }), config).isAdmin).toBe(false);
  });

  it.each([
    ['wrong signing secret', () => forge(claims, 'x'.repeat(40))],
    ['alg none', () => jwt.sign(claims, '', { algorithm: 'none', expiresIn: 60 })],
    ['disallowed algorithm HS512', () => forge(claims, config.JWT_SECRET, { algorithm: 'HS512' })],
    ['expired', () => jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, config.JWT_SECRET, { algorithm: 'HS256' })],
    ['no exp', () => jwt.sign(claims, config.JWT_SECRET, { algorithm: 'HS256' })],
    ['wrong issuer', () => forge({ ...claims, iss: 'someone-else' })],
    ['wrong audience', () => forge({ ...claims, aud: 'other-api' })],
    ['missing sub', () => forge({ iss: claims.iss, aud: claims.aud })],
    ['empty sub', () => forge({ ...claims, sub: '' })],
    ['garbage', () => 'not.a.jwt'],
  ])('rejects %s with 401', (_name, make) => {
    expect(() => verifyToken(make(), config)).toThrowError(expect.objectContaining({ status: 401, code: 'unauthorized' }));
  });

  it('signToken refuses unbounded lifetimes', () => {
    expect(() => signToken({ sub: 'a', ttlSeconds: 0 }, config)).toThrow(RangeError);
    expect(() => signToken({ sub: 'a', ttlSeconds: 8 * 24 * 3600 }, config)).toThrow(RangeError);
  });
});

describe('HTTP auth middleware', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = createApp({
      config,
      log: createLogger('silent'),
      routes: ({ requireUser, requireAdmin }) => {
        const r = express.Router();
        // Mirrors how real handlers must behave: identity from req.auth, body user_id ignored.
        r.post('/whoami', requireUser, (req, res) => {
          res.json({ user_id: req.auth?.userId, body_user_id_seen: req.body?.user_id ?? null });
        });
        r.post('/admin-only', requireAdmin, (_req, res) => {
          res.json({ ok: true });
        });
        return r;
      },
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const call = (path: string, token?: string, body: object = {}, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });

  it('returns 401 with the error envelope when the token is missing or invalid', async () => {
    for (const token of [undefined, 'garbage']) {
      const res = await call('/whoami', token);
      expect(res.status).toBe(401);
      const body = await json(res);
      expect(body.error.code).toBe('unauthorized');
      expect(typeof body.request_id).toBe('string');
      expect(JSON.stringify(body)).not.toContain(config.JWT_SECRET);
    }
  });

  it('ignores a spoofed user_id in the body', async () => {
    const res = await call('/whoami', signToken({ sub: 'alice' }, config), { user_id: 'bob' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ user_id: 'alice', body_user_id_seen: 'bob' });
  });

  it('gives 403 to a non-admin and 200 to an admin', async () => {
    const user = await call('/admin-only', signToken({ sub: 'alice' }, config));
    expect(user.status).toBe(403);
    expect((await json(user)).error.code).toBe('forbidden');
    // a body claiming admin does not matter either
    expect((await call('/admin-only', signToken({ sub: 'alice' }, config), { role: 'admin' })).status).toBe(403);
    expect((await call('/admin-only', signToken({ sub: 'root', admin: true }, config))).status).toBe(200);
  });

  it('echoes a valid X-Request-Id, replaces an invalid one, and wraps unknown routes and bad JSON', async () => {
    const ok = await call('/whoami', undefined, {}, { 'x-request-id': 'trace-123' });
    expect((await json(ok)).request_id).toBe('trace-123');
    const bad = await call('/whoami', undefined, {}, { 'x-request-id': 'bad id with spaces!' });
    expect((await json(bad)).request_id).not.toBe('bad id with spaces!');

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect((await json(missing)).error.code).toBe('not_found');

    const malformed = await fetch(`${base}/whoami`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(malformed.status).toBe(400);
    expect((await json(malformed)).error.code).toBe('validation_error');
  });
});
