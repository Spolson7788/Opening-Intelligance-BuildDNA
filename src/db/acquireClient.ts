import type { Response } from 'express';
import { pool } from './pool';

// Only checkout is handled here: never retry a transaction or a write whose
// outcome may be uncertain. Existing handlers retain ownership of release.
export async function acquireClient(res: Response) {
  try {
    return await pool.connect();
  } catch {
    res.set('Cache-Control', 'no-store').status(503).json({ error: 'database_unavailable' });
    return null;
  }
}
