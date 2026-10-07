import {canFocusMarking} from './focusedMarking';
import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../db/pool';
export const STAGED_LOCATOR_MS=30_000;
export const STAGED_READER_MS=32_000;
export function stagedInputKey(body:{opening_id:string;photo_ids?:string[];media_type:string;technician_attributes:Record<string,string>;request_id?:string}){
 return createHash('sha256').update(JSON.stringify({opening:body.opening_id,photos:body.photo_ids,type:body.media_type,attributes:Object.entries(body.technician_attributes).sort(([a],[b])=>a.localeCompare(b)),request:body.request_id})).digest('hex');
}
export function validateStageResume(run:any,scope:{organizationId:string;userId:string;openingId:string},build:string|null,inputKey:string){
 if(!run||run.organization_id!==scope.organizationId||run.user_id!==scope.userId||run.opening_id!==scope.openingId)throw Error('recognition_stage_not_found');
 if(run.stage_one?.recognition_versions?.build_sha!==build||run.stage_one?.staged_execution?.input_key!==inputKey)throw Error('recognition_stage_input_changed');
 if(run.status!=='running'||!['readers_ready','focus_ready'].includes(run.stage_one.staged_execution.phase))throw Error('recognition_stage_not_resumable');
 const regions=run.stage_one?.staged_execution?.phase==='focus_ready'?run.stage_one?.label_reading?.reads?.filter(canFocusMarking).map((r:any)=>r.region):run.stage_one?.label_reading?.planned_regions;
 if(!Array.isArray(regions)||!regions.length)throw Error('recognition_stage_evidence_missing');
 return regions;
}
// Only a persisted, unclaimed reader stage can advance. An expired active
// lease never authorizes an automatic paid retry; its outcome may be unknown.
export async function claimReaderStage(id:string,scope:{organizationId:string;userId:string;openingId:string},build:string|null,inputKey:string){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const run=(await client.query('SELECT * FROM recognition_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const regions=validateStageResume(run,scope,build,inputKey);
  const token=randomUUID();const mode:'focus'|'read'=run.stage_one.staged_execution.phase==='focus_ready'?'focus':'read';
  await client.query(`UPDATE recognition_runs SET stage_one=jsonb_set(stage_one,'{staged_execution}',stage_one->'staged_execution'||$2::jsonb) WHERE id=$1`,[id,JSON.stringify({phase:mode==='focus'?'focusing':'reading',lease_token:token,started_at:new Date().toISOString()})]);
  await client.query('COMMIT');return {id,regions,token,hashes:run.photo_hashes,mode,labels:run.stage_one.label_reading};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
