import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,requireRole,AuthedRequest} from '../middleware/auth';
import {auditLog} from '../middleware/auditLog';
export const branchesRouter=Router();
branchesRouter.use(requireAuth,requireRole('admin'),auditLog);
branchesRouter.get('/',async(req:AuthedRequest,res)=>{
 try {
 const branches=await pool.query('SELECT * FROM company_branches WHERE organization_id=$1 ORDER BY name',[req.auth!.organizationId]);
 const users=await pool.query(`SELECT u.id,u.full_name,u.email,u.role,u.is_active,a.branch_id FROM users u LEFT JOIN user_branch_assignments a ON a.user_id=u.id AND a.organization_id=u.organization_id WHERE u.organization_id=$1 ORDER BY u.full_name`,[req.auth!.organizationId]);
 res.set('Cache-Control','no-store').json({branches:branches.rows,users:users.rows});
 }catch{res.status(503).json({error:'branch_read_failed'});}
});
const branch=z.object({name:z.string().trim().min(1).max(120),default_state:z.string().regex(/^[A-Z]{2}$/),default_territory:z.string().trim().min(1).max(120).nullable(),is_active:z.boolean()}).strict();
branchesRouter.put('/:id',async(req:AuthedRequest,res)=>{
 const body=branch.safeParse(req.body);if(!body.success||!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'invalid_branch'});
 try{const b=body.data;const r=await pool.query(`INSERT INTO company_branches(id,organization_id,name,default_state,default_territory,is_active) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=$3,default_state=$4,default_territory=$5,is_active=$6 WHERE company_branches.organization_id=$2 RETURNING *`,[req.params.id,req.auth!.organizationId,b.name,b.default_state,b.default_territory,b.is_active]);
 if(!r.rowCount)return res.status(404).json({error:'not_found'});res.json(r.rows[0]);
 }catch(e:any){res.status(e.code==='23505'?409:503).json({error:'branch_save_failed'});}
});
branchesRouter.put('/assignments/:userId',async(req:AuthedRequest,res)=>{
 const body=z.object({branch_id:z.string().uuid().nullable()}).strict().safeParse(req.body);
 if(!body.success||!z.string().uuid().safeParse(req.params.userId).success)return res.status(400).json({error:'invalid_assignment'});
 const c=await pool.connect();try{
 await c.query('BEGIN');const u=await c.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND is_active=true FOR UPDATE',[req.params.userId,req.auth!.organizationId]);
 if(!u.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
 if(body.data.branch_id){const b=await c.query('SELECT id FROM company_branches WHERE id=$1 AND organization_id=$2 AND is_active=true FOR SHARE',[body.data.branch_id,req.auth!.organizationId]);
 if(!b.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
 await c.query(`INSERT INTO user_branch_assignments(user_id,organization_id,branch_id,assigned_by_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET organization_id=$2,branch_id=$3,assigned_by_user_id=$4,assigned_at=now()`,[req.params.userId,req.auth!.organizationId,body.data.branch_id,req.auth!.userId]);
 }else await c.query('DELETE FROM user_branch_assignments WHERE user_id=$1 AND organization_id=$2',[req.params.userId,req.auth!.organizationId]);
 await c.query('COMMIT');res.json({saved:true});
 }catch{await c.query('ROLLBACK');res.status(503).json({error:'branch_assignment_failed'});}finally{c.release();}
});
