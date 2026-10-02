import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_SECRET: 'x'.repeat(32) };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.DB_POOL_MAX).toBe(20);
  });
  it('rejects a short JWT secret without echoing it', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short-secret' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short-secret' })).not.toThrow(/short-secret/);
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ JWT_SECRET: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
  });
});
