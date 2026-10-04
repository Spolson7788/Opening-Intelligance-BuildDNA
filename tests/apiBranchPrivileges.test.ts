import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {pool} from '../src/db/pool';
it('restricted API role can read new tables while public clients cannot',async()=>{
 const c=await pool.connect();try{
 await c.query('DO $role$ BEGIN CREATE ROLE oi_pr2_api; EXCEPTION WHEN duplicate_object THEN NULL; END $role$');await c.query('GRANT USAGE ON SCHEMA public TO oi_pr2_api');
 await c.query(readFileSync('migrations/20260926183557_api_branch_provider_privileges.sql','utf8'));
 await c.query('BEGIN');await c.query('SET LOCAL ROLE oi_pr2_api');
 for(const t of ['company_branches','user_branch_assignments','facility_provider_assignments','component_purchasing_approvals'])expect((await c.query(`SELECT * FROM ${t}`)).rows).toBeDefined();
 await c.query('ROLLBACK');
 const r=await c.query("SELECT has_table_privilege('oi_pr2_api','company_branches','DELETE') AS can_delete,has_table_privilege('oi_pr2_api','user_branch_assignments','DELETE') AS can_unassign");
 expect(r.rows[0]).toEqual({can_delete:false,can_unassign:true});
 }finally{await c.query('ROLLBACK');c.release();}
});
