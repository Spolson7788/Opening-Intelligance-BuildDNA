import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {enforceRolePermissions} from '../middleware/permissions';
import {auditLog} from '../middleware/auditLog';
import {purchasingReview} from '../services/purchasingReview';
export const purchasingRouter=Router();
purchasingRouter.use(requireAuth,enforceRolePermissions,auditLog);
purchasingRouter.post('/review',async(req:AuthedRequest,res)=>{
 const p=z.object({opening_ids:z.array(z.string().uuid()).min(1).max(100)}).strict().safeParse(req.body);
 if(!p.success)return res.status(400).json({error:'invalid_review'});
 const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const result=await purchasingReview(c,req.auth!.organizationId,p.data.opening_ids);await c.query('COMMIT');
 if(!result)return res.status(404).json({error:'not_found'});res.set('Cache-Control','no-store').json(result);
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'review_failed'});}finally{c.release();}
});
// Explicit owner-admin evidence approval. Field edits cannot self-approve a document.
purchasingRouter.put('/approvals/:id',async(req:AuthedRequest,res)=>{
 if(req.auth!.role!=='admin')return res.status(403).json({error:'owner_admin_required'});
 const p=z.object({document_url:z.string().url().refine(v=>new URL(v).protocol==='https:'),document_sha256:z.string().regex(/^[0-9a-f]{64}$/),provenance:z.enum(['technician_selected','oi_established']),active:z.boolean()}).strict().safeParse(req.body);
 if(!p.success||!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'invalid_approval'});
 const c=await pool.connect();try{await c.query('BEGIN');
 const h=await c.query(`SELECT h.* FROM hardware_components h JOIN openings o ON o.id=h.opening_id JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id JOIN portfolios pf ON pf.id=p.portfolio_id WHERE h.id=$1 AND pf.organization_id=$2 FOR UPDATE OF h`,[req.params.id,req.auth!.organizationId]);
 if(!h.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
 const row=h.rows[0];if(!row.manufacturer?.trim()||!row.model_number?.trim()||row.identity_status!=='established'){await c.query('ROLLBACK');return res.status(409).json({error:'identity_unresolved'});}
 const d=p.data;
 const result=await c.query(`INSERT INTO component_purchasing_approvals(component_id,manufacturer,model_number,component_type,document_url,document_sha256,provenance,approved_by_user_id,revoked_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN NULL ELSE now() END)
 ON CONFLICT(component_id) DO UPDATE SET manufacturer=$2,model_number=$3,component_type=$4,document_url=$5,document_sha256=$6,provenance=$7,approved_by_user_id=$8,approved_at=now(),revoked_at=CASE WHEN $9 THEN NULL ELSE now() END RETURNING *`,[row.id,row.manufacturer,row.model_number,row.component_type,d.document_url,d.document_sha256,d.provenance,req.auth!.userId,d.active]);
 await c.query('COMMIT');res.json(result.rows[0]);
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'approval_failed'});}finally{c.release();}
});
