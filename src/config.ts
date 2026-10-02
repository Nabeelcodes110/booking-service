import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('booking-service'),
  JWT_AUDIENCE: z.string().min(1).default('booking-api'),
  AMQP_URL: z.string().min(1).optional(),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
});

export type Config = z.infer<typeof schema>;

/** Parse and validate environment once at startup; fail fast with variable names only (never values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}
