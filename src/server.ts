import { Router } from 'express';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { createLogger } from './logger';
import { ReservationController } from './reservations/reservation.controller';
import { ReservationRepository } from './reservations/reservation.repository';
import { reservationRoutes } from './reservations/reservation.routes';
import { ReservationService } from './reservations/reservation.service';
import { ShowController } from './shows/show.controller';
import { ShowRepository } from './shows/show.repository';
import { showRoutes } from './shows/show.routes';
import { ShowService } from './shows/show.service';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config);

// Composition root: repository -> service -> controller -> routes.
const showController = new ShowController(new ShowService(pool, new ShowRepository()));
const reservationController = new ReservationController(new ReservationService(pool, new ReservationRepository()));
const app = createApp({
  config,
  log,
  routes: (auth) =>
    Router()
      .use(showRoutes(showController, auth.requireAdmin))
      .use(reservationRoutes(reservationController, auth.requireUser)),
});
const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, 'listening'));

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool, then exit.
function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), config.SHUTDOWN_GRACE_MS);
  timer.unref();
  server.close(() => {
    pool.end().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
