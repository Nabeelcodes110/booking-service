/**
 * Offline token generator for local development, evaluators and the burst tool.
 * Reads JWT_SECRET from the environment/.env and prints tokens to stdout. The secret is never printed,
 * and nothing in the HTTP API can mint tokens.
 *
 *   npm run token -- --sub alice                       one user token
 *   npm run token -- --sub admin-1 --admin             admin token
 *   npm run token -- --count 500 --prefix burst-user   JSON array of {sub, token}
 */
import { parseArgs } from 'node:util';
import { signToken } from '../auth';
import { loadConfig } from '../config';

const { values } = parseArgs({
  options: {
    sub: { type: 'string' },
    admin: { type: 'boolean', default: false },
    'ttl-seconds': { type: 'string', default: '3600' },
    count: { type: 'string' },
    prefix: { type: 'string', default: 'user' },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch {
  fail('JWT_SECRET (min 32 chars) and DATABASE_URL must be set in the environment or .env');
}

const ttlSeconds = Number(values['ttl-seconds']);
try {
  if (values.count !== undefined) {
    const count = Number(values.count);
    if (!Number.isInteger(count) || count < 1 || count > 100_000) fail('--count must be an integer between 1 and 100000');
    const tokens = Array.from({ length: count }, (_, i) => {
      const sub = `${values.prefix}-${i + 1}`;
      return { sub, token: signToken({ sub, admin: values.admin, ttlSeconds }, config) };
    });
    process.stdout.write(`${JSON.stringify(tokens)}\n`);
  } else {
    if (!values.sub) fail('--sub <user id> is required (or use --count)');
    process.stdout.write(`${signToken({ sub: values.sub, admin: values.admin, ttlSeconds }, config)}\n`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : 'failed to sign token');
}
