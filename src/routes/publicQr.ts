import { Router } from 'express';
import { pool } from '../db/pool';

// Deliberately independent of authenticated opening DTOs. Never spread a row.
export interface PublicOpeningSummary {
  facility_name: string;
  building_name: string;
}
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPublicQrRouter(options: {
  query?: (sql: string, values: string[]) => Promise<{ rows: any[] }>;
  now?: () => number;
  limit?: number;
} = {}) {
  const router = Router();
  const query = options.query ?? ((sql, values) => pool.query(sql, values));
  const now = options.now ?? Date.now;
  // Constant-space, per-process ceiling. This is not a distributed abuse limit;
  // public activation also requires platform-level rate protection/capacity review.
  let windowStart = now(), requests = 0;
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Authorization, Cookie');
    res.set('X-Content-Type-Options', 'nosniff');
    const time = now();
    if (time - windowStart >= 60_000) { windowStart = time; requests = 0; }
    if (++requests > (options.limit ?? 60)) {
      res.set('Retry-After', '60').status(429).json({ error: 'temporarily_unavailable' });
      return;
    }
    next();
  });
  router.get('/:token', async (req, res) => {
    if (!tokenPattern.test(req.params.token)) return res.status(404).json({ error: 'not_found' });
    try {
      const result = await query(`SELECT p.name AS facility_name, b.name AS building_name
        FROM openings o JOIN buildings b ON b.id=o.building_id
        JOIN properties p ON p.id=b.property_id
        WHERE o.qr_token=$1 AND o.completion_state='complete'
          AND o.status NOT IN ('retired','decommissioned')`, [req.params.token]);
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: 'not_found' });
      if (![row.facility_name, row.building_name].every(v => typeof v === 'string')) {
        return res.status(503).json({ error: 'temporarily_unavailable' });
      }
      const summary: PublicOpeningSummary = {
        // t97: outsiders see only the facility and building names.
        facility_name: row.facility_name, building_name: row.building_name,
      };
      return res.json(summary);
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });
  return router;
}
