import { acquireClient } from '../db/acquireClient';
import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {enforceRolePermissions} from '../middleware/permissions';
import {auditLog} from '../middleware/auditLog';
import {purchasingReview} from '../services/purchasingReview';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {areaAllowsOpening} from '../db/areaAccess';
import {resolvePurchasingDestination, sendPurchasingPackage} from '../services/purchasingSend';
export const purchasingRouter=Router();
purchasingRouter.use(requireAuth,enforceRolePermissions,auditLog);
purchasingRouter.post('/review',async(req:AuthedRequest,res)=>{
 const p=z.object({opening_ids:z.array(z.string().uuid()).min(1).max(500)}).strict().safeParse(req.body);
 if(!p.success)return res.status(400).json({error:'invalid_review'});
 const c = await acquireClient(res); if (!c) return;try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const result=await purchasingReview(c,req.auth!.organizationId,p.data.opening_ids);await c.query('COMMIT');
 if(!result)return res.status(404).json({error:'not_found'});res.set('Cache-Control','no-store').json(result);
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'review_failed'});}finally{c.release();}
});
// Explicit owner-admin evidence approval. Field edits cannot self-approve a document.
purchasingRouter.put('/approvals/:id',async(req:AuthedRequest,res)=>{
 if(req.auth!.role!=='admin')return res.status(403).json({error:'owner_admin_required'});
 const p=z.object({document_url:z.string().url().refine(v=>new URL(v).protocol==='https:'),document_sha256:z.string().regex(/^[0-9a-f]{64}$/),provenance:z.enum(['technician_selected','oi_established']),active:z.boolean()}).strict().safeParse(req.body);
 if(!p.success||!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'invalid_approval'});
 const c = await acquireClient(res); if (!c) return;try{await c.query('BEGIN');
 const h=await c.query(`SELECT h.* FROM hardware_components h JOIN openings o ON o.id=h.opening_id JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id JOIN portfolios pf ON pf.id=p.portfolio_id WHERE h.id=$1 AND h.lifecycle_state='active' AND pf.organization_id=$2 FOR UPDATE OF h`,[req.params.id,req.auth!.organizationId]);
 if(!h.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
 const row=h.rows[0];if(!row.manufacturer?.trim()||!row.model_number?.trim()||row.identity_status!=='established'){await c.query('ROLLBACK');return res.status(409).json({error:'identity_unresolved'});}
 const d=p.data;
 const result=await c.query(`INSERT INTO component_purchasing_approvals(component_id,manufacturer,model_number,component_type,document_url,document_sha256,provenance,approved_by_user_id,revoked_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN NULL ELSE now() END)
 ON CONFLICT(component_id) DO UPDATE SET manufacturer=$2,model_number=$3,component_type=$4,document_url=$5,document_sha256=$6,provenance=$7,approved_by_user_id=$8,approved_at=now(),revoked_at=CASE WHEN $9 THEN NULL ELSE now() END RETURNING *`,[row.id,row.manufacturer,row.model_number,row.component_type,d.document_url,d.document_sha256,d.provenance,req.auth!.userId,d.active]);
 await c.query('COMMIT');res.json(result.rows[0]);
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'approval_failed'});}finally{c.release();}
});

const purchasingEmail = z.string().trim().email().max(200);
purchasingRouter.get('/company-email', async (req: AuthedRequest, res) => {
  try {
    const r = await pool.query('SELECT purchasing_email FROM organizations WHERE id=$1', [req.auth!.organizationId]);
    res.set('Cache-Control', 'no-store').json({ purchasing_email: r.rows[0]?.purchasing_email ?? null });
  } catch { res.status(503).json({ error: 'purchasing_email_read_failed' }); }
});
function canSetPurchasingEmail(role: string | undefined) {
  return role === 'admin' || role === 'facilities_manager';
}

purchasingRouter.get('/branch-emails', async (req: AuthedRequest, res) => {
  if (!canSetPurchasingEmail(req.auth!.role)) return res.status(403).json({ error: 'insufficient_role_for_action' });
  try {
    const r = await pool.query(
      'SELECT id, name, purchasing_email FROM company_branches WHERE organization_id=$1 AND is_active=true ORDER BY name',
      [req.auth!.organizationId],
    );
    res.set('Cache-Control', 'no-store').json({ branches: r.rows });
  } catch { res.status(503).json({ error: 'purchasing_email_read_failed' }); }
});

purchasingRouter.put('/branches/:id/email', async (req: AuthedRequest, res) => {
  if (!canSetPurchasingEmail(req.auth!.role)) return res.status(403).json({ error: 'insufficient_role_for_action' });
  const body = z.object({ purchasing_email: purchasingEmail.nullable() }).strict().safeParse(req.body);
  if (!body.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_email' });
  try {
    const r = await pool.query(
      'UPDATE company_branches SET purchasing_email=$3 WHERE id=$1 AND organization_id=$2 RETURNING id, name, purchasing_email',
      [req.params.id, req.auth!.organizationId, body.data.purchasing_email],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch { res.status(503).json({ error: 'purchasing_email_save_failed' }); }
});

purchasingRouter.put('/company-email', async (req: AuthedRequest, res) => {
  if (!canSetPurchasingEmail(req.auth!.role)) return res.status(403).json({ error: 'insufficient_role_for_action' });
  const body = z.object({ purchasing_email: purchasingEmail.nullable() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_email' });
  try {
    const r = await pool.query('UPDATE organizations SET purchasing_email=$2 WHERE id=$1 RETURNING purchasing_email', [req.auth!.organizationId, body.data.purchasing_email]);
    res.json({ purchasing_email: r.rows[0]?.purchasing_email ?? null });
  } catch { res.status(503).json({ error: 'purchasing_email_save_failed' }); }
});

const sendBody = z.object({
  opening_id: z.string().uuid(),
  hardware_component_id: z.string().uuid(),
  note: z.string().max(2000).optional(),
  document_ids: z.array(z.string().uuid()).max(5).optional(),
  reference_sha256s: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(5).optional(),
  include_approved_document: z.boolean().optional(),
  branch_id: z.string().uuid().optional(),
  uploads: z.array(z.object({ filename: z.string().trim().min(1).max(180), content_base64: z.string().min(8).max(20_000_000) }).strict()).max(5).optional(),
}).strict();

purchasingRouter.get('/destination', async (req: AuthedRequest, res) => {
  const query = z.object({ opening_id: z.string().uuid(), branch_id: z.string().uuid().optional() }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: 'invalid_destination' });
  try {
    const owned = await pool.query(
      `SELECT 1 FROM openings o WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})`,
      [query.data.opening_id, req.auth!.organizationId],
    );
    if (!owned.rowCount || !(await areaAllowsOpening(req.auth!.userId, query.data.opening_id))) return res.status(403).json({ error: 'forbidden' });
    const destination = await resolvePurchasingDestination(pool, {
      organizationId: req.auth!.organizationId,
      openingId: query.data.opening_id,
      branchId: query.data.branch_id,
    });
    if (!destination.ok) return res.json({ ready: false, error: destination.error, choices: destination.choices ?? [] });
    res.set('Cache-Control', 'no-store').json({ ready: true, to: destination.to, source: destination.source, branch: destination.branch });
  } catch (e) { console.error(e); res.status(500).json({ error: 'purchasing_destination_failed' }); }
});

purchasingRouter.post('/send', async (req: AuthedRequest, res) => {
  const body = sendBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_send' });
  const b = body.data;
  try {
    const owned = await pool.query(
      `SELECT 1 FROM hardware_components h WHERE h.id=$1 AND h.opening_id=$2 AND h.opening_id IN (${openingsForOrgSubquery(3)})`,
      [b.hardware_component_id, b.opening_id, req.auth!.organizationId],
    );
    if (!owned.rowCount || !(await areaAllowsOpening(req.auth!.userId, b.opening_id))) return res.status(403).json({ error: 'forbidden' });
    const result = await sendPurchasingPackage(pool, {
      openingId: b.opening_id,
      hardwareComponentId: b.hardware_component_id,
      organizationId: req.auth!.organizationId,
      userId: req.auth!.userId,
      note: b.note,
      documentIds: b.document_ids ?? [],
      referenceSha256s: b.reference_sha256s ?? [],
      includeApproved: b.include_approved_document === true,
      uploads: b.uploads ?? [],
      branchId: b.branch_id,
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error, choices: result.choices });
    res.status(201).json(result.send);
  } catch (e) { console.error(e); res.status(500).json({ error: 'purchasing_send_failed' }); }
});

purchasingRouter.get('/sends/:sendId/files/:fileId', async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.sendId).success || !z.string().uuid().safeParse(req.params.fileId).success) return res.status(400).json({ error: 'invalid_file' });
  try {
    const file = await pool.query(
      `SELECT f.content, f.filename, f.content_type, s.opening_id
       FROM purchasing_send_files f JOIN purchasing_sends s ON s.id=f.send_id
       WHERE f.id=$1 AND s.id=$2 AND s.opening_id IN (${openingsForOrgSubquery(3)})`,
      [req.params.fileId, req.params.sendId, req.auth!.organizationId],
    );
    if (!file.rows[0]?.content) return res.status(404).json({ error: 'not_found' });
    if (!(await areaAllowsOpening(req.auth!.userId, file.rows[0].opening_id))) return res.status(403).json({ error: 'forbidden' });
    res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${file.rows[0].filename}"`).send(file.rows[0].content);
  } catch { res.status(503).json({ error: 'file_read_failed' }); }
});
