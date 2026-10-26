import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { openingsForOrgSubquery } from '../db/tenantScope';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { enforceRolePermissions } from '../middleware/permissions';
import { canonicalPayloadHash, findSyncReceipt, writeSyncReceiptAndAudit } from '../services/syncProtocol';
import { conditionObservationSchema, conditionObservationView, conditionTargetView } from '../services/conditionObservations';
import { facilityHistory } from '../services/facilityHistory';

export const conditionHistoryRouter = Router();
conditionHistoryRouter.use(requireAuth, enforceRolePermissions);
const uuid = z.string().uuid();
const command = z.object({
  operation_id: uuid, entity_id: uuid, opening_id: uuid, device_id: uuid,
  schema_version: z.literal(3), app_version: z.string().min(1).max(100), protocol_version: z.literal(1),
  expected_revision: z.number().int().positive().safe(), payload: conditionObservationSchema,
}).strict();
async function scope(c: any, id: string, org: string) {
  return (await c.query(`SELECT * FROM openings WHERE id=$1 AND id IN (${openingsForOrgSubquery(2)})`, [id, org])).rows[0];
}
class ConditionConflict extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}

conditionHistoryRouter.get('/facility/:openingId', async (req: AuthedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  if (!uuid.safeParse(req.params.openingId).success) return res.status(400).json({ error: 'invalid_opening' });
  let c: PoolClient | undefined;
  try {
    c = await pool.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await facilityHistory(c, req.params.openingId, req.auth!.organizationId);
    await c.query('COMMIT');
    return report ? res.json(report) : res.status(404).json({ error: 'not_found' });
  } catch (e: any) {
    if(c) await c.query('ROLLBACK').catch(()=>{});
    return res.status(e.message === 'facility_history_too_large' ? 413 : 500).json({
      error: e.message === 'facility_history_too_large' ? e.message : 'facility_history_unavailable',
    });
  } finally { c?.release(); }
});

conditionHistoryRouter.get('/:openingId', async (req: AuthedRequest, res) => {
  if (!uuid.safeParse(req.params.openingId).success) return res.status(400).json({ error: 'invalid_opening' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const o = await scope(c, req.params.openingId, req.auth!.organizationId);
    if (!o) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const frames = (await c.query('SELECT id FROM opening_frames WHERE opening_id=$1 ORDER BY id', [o.id])).rows;
    const leaves = (await c.query('SELECT id,leaf_role FROM door_leaves WHERE opening_id=$1 ORDER BY leaf_role,id', [o.id])).rows;
    // Physical predecessors remain addressable; history is not a current-only projection.
    const components = (await c.query(`SELECT h.id,h.component_type,h.manufacturer,h.model_number,h.mounting_scope,
      h.frame_id,h.door_leaf_id,h.tracker_id,h.lifecycle_state,l.leaf_role
      FROM hardware_components h LEFT JOIN door_leaves l ON l.id=h.door_leaf_id AND l.opening_id=h.opening_id
      WHERE h.opening_id=$1 ORDER BY h.id`, [o.id])).rows;
    const observations = (await c.query(`SELECT f.*,NOT EXISTS(SELECT 1 FROM condition_observations n WHERE n.correction_of=f.id) AS is_current
      FROM condition_observations f WHERE opening_id=$1 ORDER BY recorded_at,id`, [o.id])).rows;
    await c.query('COMMIT');
    return res.json({ opening_id: o.id, opening_code: o.opening_code, revision: Number(o.revision), status: o.status,
      targets: [...frames.map(r => conditionTargetView('frame', r)), ...leaves.map(r => conditionTargetView('door_leaf', r)),
        ...components.map(r => conditionTargetView('component', r))], observations: observations.map(conditionObservationView) });
  } catch {
    await c.query('ROLLBACK');
    return res.status(500).json({ error: 'condition_history_unavailable' });
  } finally { c.release(); }
});

conditionHistoryRouter.post('/observations', async (req: AuthedRequest, res) => {
  const parsed = command.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_condition_observation', details: parsed.error.flatten() });
  const b = parsed.data, p = b.payload, org = req.auth!.organizationId, actor = req.auth!.userId;
  const hash = canonicalPayloadHash({ command: 'condition_observation', entity_id: b.entity_id,
    opening_id: b.opening_id, expected_revision: b.expected_revision, payload: p });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Same lock order as installation/replacement writes and provider assignment changes.
    await c.query('SELECT id FROM openings WHERE id=$1 FOR UPDATE', [b.opening_id]);
    await c.query('SELECT p.id FROM properties p JOIN buildings b ON b.property_id=p.id JOIN openings o ON o.building_id=b.id WHERE o.id=$1 FOR SHARE OF p', [b.opening_id]);
    const o = await scope(c, b.opening_id, org);
    if (!o) throw new ConditionConflict('not_found', 404);
    // Reauthorize before receipt replay; current middleware also checks account/role.
    const prior = await findSyncReceipt(c, org, b.operation_id);
    if (prior) {
      if (prior.actor_user_id !== actor || prior.payload_hash !== hash || prior.entity_id !== b.entity_id || prior.entity_type !== 'condition_observation') {
        throw new ConditionConflict('idempotency_key_reused');
      }
      await c.query('ROLLBACK'); return res.json(prior);
    }
    if (o.status === 'decommissioned') throw new ConditionConflict('opening_retired');
    if (Number(o.revision) !== b.expected_revision) throw new ConditionConflict('revision_conflict');
    const table = { frame: 'opening_frames', door_leaf: 'door_leaves', component: 'hardware_components' }[p.target.type];
    const target = (await c.query(`SELECT * FROM ${table} WHERE id=$1 AND opening_id=$2 FOR SHARE`, [p.target.id, b.opening_id])).rows[0];
    if (!target) throw new ConditionConflict('target_not_in_opening');
    if (p.target.type === 'component' && target.door_leaf_id) {
      const leaf = (await c.query('SELECT leaf_role FROM door_leaves WHERE id=$1 AND opening_id=$2 FOR SHARE', [target.door_leaf_id, b.opening_id])).rows[0];
      target.leaf_role = leaf?.leaf_role ?? null;
    }
    let snapshot = conditionTargetView(p.target.type, target);
    if (p.correction_of) {
      const old = (await c.query('SELECT * FROM condition_observations WHERE id=$1 AND opening_id=$2', [p.correction_of, b.opening_id])).rows[0];
      if (!old || old.target_type !== p.target.type || old.target_id !== p.target.id) throw new ConditionConflict('correction_target_mismatch');
      if ((await c.query('SELECT 1 FROM condition_observations WHERE correction_of=$1', [p.correction_of])).rows[0]) throw new ConditionConflict('observation_already_corrected');
      // A later remount or rename must not rewrite where the original observation belonged.
      snapshot = old.target_snapshot;
    }
    const d = p.observed_date;
    const row = (await c.query(`INSERT INTO condition_observations
      (id,opening_id,target_type,target_id,frame_id,door_leaf_id,hardware_component_id,condition,
       certainty,precision,year,month,day,source_reference,note,target_snapshot,recorded_by_user_id,recording_organization_id,correction_of,correction_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [b.entity_id,b.opening_id,p.target.type,p.target.id,p.target.type==='frame'?p.target.id:null,
      p.target.type==='door_leaf'?p.target.id:null,p.target.type==='component'?p.target.id:null,
      p.condition,d.certainty,d.precision,d.year,d.month,d.day,p.source_reference,p.note,JSON.stringify(snapshot),
      actor,org,p.correction_of,p.correction_reason])).rows[0];
    const revision = Number((await c.query('UPDATE openings SET revision=revision+1 WHERE id=$1 RETURNING revision', [b.opening_id])).rows[0].revision);
    const receipt = await writeSyncReceiptAndAudit(c, { organizationId: org, openingId: b.opening_id,
      operationId: b.operation_id, operationType: 'create', entityType: 'condition_observation', entityId: b.entity_id,
      payloadHash: hash, baseServerRevision: b.expected_revision, resultingServerRevision: revision,
      actorUserId: actor, deviceId: b.device_id, schemaVersion: 3, appVersion: b.app_version, protocolVersion: 1,
      responsePayload: conditionObservationView(row), action: p.correction_of ? 'condition_observation_corrected' : 'condition_observation_recorded',
      changedFields: Object.keys(p) });
    await c.query('COMMIT'); return res.status(201).json(receipt);
  } catch (e: any) {
    await c.query('ROLLBACK');
    if (e instanceof ConditionConflict) return res.status(e.status).json({ error: e.code });
    if (e.code === '23505' || e.code === '23503') return res.status(409).json({ error: 'condition_history_identity_conflict' });
    return res.status(500).json({ error: 'condition_history_unavailable' });
  } finally { c.release(); }
});
