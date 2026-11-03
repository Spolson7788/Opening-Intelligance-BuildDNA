import { acquireClient } from '../db/acquireClient';
import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {auditLog} from '../middleware/auditLog';
export const providerAssignmentsRouter=Router();
providerAssignmentsRouter.use(requireAuth,auditLog);
// Only the facility owner's administrator may delegate; provider admins cannot redelegate.
providerAssignmentsRouter.put('/:propertyId/:providerId',async(req:AuthedRequest,res)=>{
 if(req.auth!.role!=='admin')return res.status(403).json({error:'owner_admin_required'});
 const parsed=z.object({propertyId:z.string().uuid(),providerId:z.string().uuid()}).safeParse(req.params);
 const body=z.object({active:z.boolean()}).strict().safeParse(req.body);
 if(!parsed.success||!body.success)return res.status(400).json({error:'invalid_assignment'});
 const {propertyId,providerId}=parsed.data;
 const client = await acquireClient(res); if (!client) return;try{
 await client.query('BEGIN');
 const owner=await client.query(`SELECT p.id,o.org_type FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id JOIN organizations o ON o.id=pf.organization_id WHERE p.id=$1 AND pf.organization_id=$2 FOR UPDATE OF p`,[propertyId,req.auth!.organizationId]);
 if(!owner.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
 // A provider's own facility: only OI staff may assign another provider to it (the database enforces this too). Revoking stays allowed.
 if(owner.rows[0].org_type==='service_partner'&&body.data.active){await client.query('ROLLBACK');return res.status(403).json({error:'provider_facility_assignment_requires_oi_staff'});}
 const provider=await client.query('SELECT id FROM organizations WHERE id=$1',[providerId]);
 if(!provider.rowCount||providerId===req.auth!.organizationId){await client.query('ROLLBACK');return res.status(400).json({error:'invalid_provider'});}
 const result=await client.query(`INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id,revoked_at)
 VALUES($1,$2,$3,CASE WHEN $4 THEN NULL ELSE now() END)
 ON CONFLICT(property_id,provider_organization_id) DO UPDATE SET granted_by_user_id=$3,granted_at=now(),revoked_at=CASE WHEN $4 THEN NULL ELSE now() END RETURNING *`,[propertyId,providerId,req.auth!.userId,body.data.active]);
 await client.query('COMMIT');res.json(result.rows[0]);
 }catch(e: any){
  await client.query('ROLLBACK');
  if (e?.code === '23514' && String(e.message).includes('out_of_area')) return res.status(409).json({ error: 'out_of_area' });
  console.error(e);res.status(500).json({error:'assignment_failed'});
 }finally{client.release();}
});
