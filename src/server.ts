import { createApp } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const server = createApp().listen(config.PORT, () => log.info({ port: config.PORT }, 'listening'));

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then exit.
function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), config.SHUTDOWN_GRACE_MS);
  timer.unref();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
