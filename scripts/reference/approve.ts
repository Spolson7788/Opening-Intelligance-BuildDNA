// Platform operator CLI: DATABASE_URL must be the dedicated reference approver.
// Membership is provisioned separately by the database owner; no org role grants it.
import {pool} from '../../src/db/pool';
async function main(){
 const [doc,user,flag]=process.argv.slice(2);
 if(!/^[a-f0-9]{64}$/.test(doc||'')||!user)throw Error('Usage: tsx approve.ts DOC_SHA256 ACTOR_UUID [--approve-reviewed]');
 const c=await pool.connect();try{
  await c.query('BEGIN');
  const a=await c.query('SELECT u.organization_id FROM reference_approvers a JOIN users u ON u.id=a.user_id WHERE u.id=$1 AND u.is_active FOR SHARE',[user]);
  if(!a.rows.length)throw Error('Dedicated reference approver required');
  const d=await c.query("SELECT * FROM reference_documents WHERE sha256=$1 AND status='draft' FOR UPDATE",[doc]);
  if(!d.rows.length)throw Error('Only draft references can be approved');
  const pages=await c.query('SELECT page_no,page_class,citable,transcription_status,fraction_unverified FROM reference_pages WHERE doc_sha256=$1 ORDER BY page_no',[doc]);
  const models=await c.query('SELECT * FROM reference_document_models WHERE doc_sha256=$1',[doc]);
  const conflicts=await c.query('SELECT * FROM reference_conflicts WHERE doc_sha256=$1',[doc]);
  console.log(JSON.stringify({document:d.rows[0],pages:pages.rows,models:models.rows,conflicts:conflicts.rows},null,2));
  if(flag!=='--approve-reviewed'){await c.query('ROLLBACK');return;}
  if(!models.rows.length||!pages.rows.some(p=>p.citable))throw Error('No evidence-backed model coverage / citable pages');
  await c.query("UPDATE reference_documents SET status='approved',approved_by=$2,approved_at=now() WHERE sha256=$1",[doc,user]);
  await c.query(`INSERT INTO audit_log(organization_id,user_id,action,method,path,request_body,status_code) VALUES($1,$2,'Approved manufacturer reference','CLI','reference/approval',$3,200)`,[a.rows[0].organization_id,user,JSON.stringify({doc_sha256:doc,models:models.rows,pages:pages.rows,conflicts:conflicts.rows})]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
main().catch(()=>{console.error('Reference approval failed; transaction rolled back.');process.exitCode=1;}).finally(()=>pool.end());
