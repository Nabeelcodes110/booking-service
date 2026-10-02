import { Router, type RequestHandler } from 'express';
import type { ShowController } from './show.controller';

export function showRoutes(controller: ShowController, requireAdmin: RequestHandler): Router {
  const router = Router();
  router.post('/shows', requireAdmin, controller.create);
  router.get('/shows/:id', controller.get); // public read, per docs/API.md
  return router;
}
