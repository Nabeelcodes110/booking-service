import express, { type Router } from "express";
import { authMiddleware } from "./auth";
import type { Config } from "./config";
import { errorHandler, notFoundHandler, requestId } from "./http";
import type { Logger } from "./logger";
import { createPool } from "./db/pool";

export interface AppDeps {
  config: Config;
  log: Logger;
  pool: ReturnType<typeof createPool>;
  /** Mounted before the 404 handler; later tasks add shows/reservations/health routers here. */
  routes?: (auth: ReturnType<typeof authMiddleware>) => Router;
}

/** Build the Express app. Routes are added by later tasks (health T09, shows T05, reserve T06, ...). */
export function createApp({ config, log, pool, routes }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);

  //health checks
  app.get("/health/live", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });

  // Show creation carries up to 10,000 seat labels (~360 KB worst case), so it gets a larger body limit.
  // body-parser skips a request whose body is already parsed, so the global 64 KB parser below
  // still applies to every other route (reserve/cancel bodies are tiny).
  app.post("/shows", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "64kb" }));
  if (routes) app.use(routes(authMiddleware(config)));
  app.use(notFoundHandler);
  app.use(errorHandler(log));
  return app;
}
