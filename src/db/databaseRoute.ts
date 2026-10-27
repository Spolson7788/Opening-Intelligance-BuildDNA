import type { RequestHandler } from 'express';
import type { AuthedRequest } from '../middleware/auth';
import type { Response, NextFunction } from 'express';

// Express 4 does not consume rejected async handler promises. Contain database
// precheck failures without retrying the handler or exposing provider details.
export function databaseRoute(handler: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve().then(() => handler(req, res, next)).catch(() => {
      if (res.headersSent) { res.end(); return; }
      res.set('Cache-Control', 'no-store').status(503).json({error:'database_unavailable'});
    });
  };
}
