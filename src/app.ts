import express from 'express';

/** Build the Express app. Routes are added by later tasks (health T09, shows T05, reserve T06, ...). */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  return app;
}
