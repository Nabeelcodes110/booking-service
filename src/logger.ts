import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: 'booking-service' },
    redact: ['req.headers.authorization', '*.token', '*.jwt', '*.secret'],
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
