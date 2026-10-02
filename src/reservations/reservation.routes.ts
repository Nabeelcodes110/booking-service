import { Router, type RequestHandler } from 'express';
import type { ReservationController } from './reservation.controller';

export function reservationRoutes(controller: ReservationController, requireUser: RequestHandler): Router {
  const router = Router();
  router.post('/shows/:id/reserve', requireUser, controller.reserve);
  router.post('/reservations/:id/cancel', requireUser, controller.cancel);
  return router;
}
