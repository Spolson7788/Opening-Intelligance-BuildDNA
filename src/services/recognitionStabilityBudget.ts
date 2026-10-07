import {pool} from '../db/pool';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';

// Populated only by the Netlify handler from its trusted request context.
export const stabilityRuntime=new AsyncLocalStorage<string|undefined>();
function stabilityEnv(key:string):string|undefined {
 const netlify=(globalThis as any).Netlify;
 if(netlify?.env?.get)return netlify.env.get(key);
 return process.env.NODE_ENV==='test'?process.env[key]:undefined;
}

// Allow only the legacy Sonnet request and the bounded single-turn Opus
// grouped-photo contract. Standard direct API rates checked 2026-10-07.
// Opus input is bounded by the accepted content, not its larger context window.
export const STABILITY_MODEL='claude-sonnet-4-5-20250929';
export const STABILITY_INPUT_CEILING=200000;
export function stabilityTrialId():string|null {
 const runtime=stabilityRuntime.getStore();
 if(stabilityEnv('OI_STABILITY_TRIAL_REQUIRED')!=='true'){
  if(runtime==='deploy-preview')throw Error('stability_trial_not_configured');
  return null;
 }
 if(runtime!=='deploy-preview' && !(runtime===undefined&&process.env.NODE_ENV==='test'&&process.env.OI_STABILITY_LOCAL_TEST==='true'))throw Error('stability_nonproduction_required');
 const id=stabilityEnv('OI_STABILITY_TRIAL_ID')||'';
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw Error('stability_trial_not_configured');
 return id;
}
export function stabilityPricing(model:string){
 if(model===STABILITY_MODEL)return {input:3,output:15};
 if(model==='claude-opus-5-5')return {input:4,output:20};
 throw Error('stability_request_unsupported');
}
export function stabilityMaximum(request:any,url:string,headers:HeadersInit|undefined):number {
 const h=new Headers(headers);
 if(url!=='https://api.anthropic.com/v1/messages'||h.has('anthropic-beta'))throw Error('stability_request_unsupported');
 const opus=request.model==='claude-opus-5-5';const rates=stabilityPricing(request.model);
 if(!Number.isSafeInteger(request.max_tokens)||request.max_tokens<1||request.max_tokens>(opus?4096:2500))throw Error('stability_request_unsupported');
 if(Object.keys(request).some(k=>!(opus?['model','max_tokens','output_config','messages']:['model','max_tokens','temperature','messages']).includes(k)))throw Error('stability_request_unsupported');
 if(!Array.isArray(request.messages)||request.messages.some((m:any)=>Object.keys(m).some(k=>!['role','content'].includes(k))||m.role!=='user'||!Array.isArray(m.content)||m.content.some((b:any)=>!['text','image'].includes(b.type)||b.cache_control)))throw Error('stability_request_unsupported');
 if(opus){
  if(request.messages.length!==1||JSON.stringify(request.output_config)!==JSON.stringify({effort:'medium'}))throw Error('stability_request_unsupported');
  const blocks=request.messages[0].content,images=blocks.filter((b:any)=>b.type==='image'),texts=blocks.filter((b:any)=>b.type==='text');
  // The grouped request is deliberately much smaller than the 1M context.
  // <=5 bounded image views (4784 patches each), <=16KB literal prompt text,
  // plus 4096 framing tokens fit comfortably within the retained 200K bound.
  // The audit prepares every image to the documented Opus patch limit BEFORE
  // this check. No tools, documents, cache, system prompt or history are allowed.
  if(images.length<3||images.length>5||texts.some((b:any)=>typeof b.text!=='string'||Object.keys(b).some(k=>!['type','text'].includes(k)))||texts.reduce((n:number,b:any)=>n+Buffer.byteLength(b.text,'utf8'),0)>16000||images.some((b:any)=>Object.keys(b).some(k=>!['type','source'].includes(k))||b.source?.type!=='base64'||b.source?.media_type!=='image/jpeg'||Object.keys(b.source).some((k:string)=>!['type','media_type','data'].includes(k))))throw Error('stability_request_unsupported');
 }
 return STABILITY_INPUT_CEILING*rates.input+request.max_tokens*rates.output;
}
export function stabilityActual(usage:any,maxTokens:number,model=STABILITY_MODEL):number|null {
 const valid=(n:any)=>Number.isSafeInteger(n)&&n>=0;
 if(!usage||!valid(usage.input_tokens)||!valid(usage.output_tokens)||usage.input_tokens>STABILITY_INPUT_CEILING||usage.output_tokens>maxTokens)return null;
 if(usage.cache_creation_input_tokens||usage.cache_read_input_tokens||usage.server_tool_use)return null;
 const rates=stabilityPricing(model);return usage.input_tokens*rates.input+usage.output_tokens*rates.output;
}
// Multi-view baselines are bound to complete ordered sets, never individual
// hashes chosen from a shared pool. No expected product identity enters scope.
export function approvedPhotoSetIndex(trial:any,hashes:unknown,replayAllowance=0):number {
 if(!Array.isArray(hashes))throw Error('stability_trial_scope_mismatch');
 if(trial.approved_photo_sets==null){
  if(hashes.length===1&&hashes[0]===trial.photo_sha256)return 0;
  throw Error('stability_trial_scope_mismatch');
 }
 const sets=trial.approved_photo_sets;
 const valid=Array.isArray(sets)&&sets.length>=1&&sets.length<=10&&
  sets.every(s=>Array.isArray(s)&&s.length>=3&&s.length<=5&&new Set(s).size===s.length&&s.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))&&
  new Set(sets.map(s=>JSON.stringify(s))).size===sets.length;
 if(!valid||!Number.isSafeInteger(replayAllowance)||replayAllowance<0||replayAllowance>8||!Number.isSafeInteger(trial.max_runs)||trial.max_runs>sets.length+replayAllowance||
  createHash('sha256').update(JSON.stringify(sets)).digest('hex')!==trial.photo_sha256)throw Error('stability_trial_scope_mismatch');
 const index=sets.findIndex(s=>JSON.stringify(s)===JSON.stringify(hashes));
 if(index<0)throw Error('stability_trial_scope_mismatch');
 return index;
}
async function transaction<T>(work:(client:any)=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function registerStabilityRun(runId:string,requestId:string|undefined):Promise<void>{
 const trialId=stabilityTrialId();if(!trialId)return;
 if(!requestId)throw Error('stability_request_id_required');
 const accepted=await transaction(async c=>{
  const trial=(await c.query('SELECT * FROM recognition_stability_trials WHERE id=$1 FOR UPDATE',[trialId])).rows[0];
  const run=(await c.query('SELECT * FROM recognition_runs WHERE id=$1',[runId])).rows[0];
  if(!trial||trial.state!=='open')throw Error('stability_trial_unavailable');
  const abandoned=(await c.query(`SELECT 1 FROM recognition_stability_reservations b JOIN recognition_provider_attempts a ON a.id=b.attempt_id JOIN recognition_runs r ON r.id=a.run_id
   WHERE b.trial_id=$1 AND b.outcome='reserved' AND (r.status<>'running' OR a.started_at<now()-interval '60 seconds') LIMIT 1`,[trialId])).rows.length;
  if(abandoned){await c.query("UPDATE recognition_stability_trials SET state='paused' WHERE id=$1",[trialId]);return false;}
  if(!run||run.organization_id!==trial.organization_id||run.user_id!==trial.user_id||run.opening_id!==trial.opening_id)throw Error('stability_trial_scope_mismatch');
  const build=run.stage_one?.recognition_versions?.build_sha;
  // A separate, actor-scoped authorization grants one comparison on one exact
  // build. The photo scope, costs and previous records remain unchanged.
  const replay=Array.isArray(trial.approved_photo_sets)&&trial.max_runs>trial.approved_photo_sets.length&&/^[a-f0-9]{40}$/.test(build||'')?
   (await c.query(`SELECT id,request_body FROM audit_log WHERE organization_id=$1 AND user_id=$2 AND action='Authorized recognition rerun'
    AND request_body->>'trial_id'=$3 AND request_body->>'build_sha'=$4 AND request_body->'photo_hashes'=$5::jsonb
    ORDER BY created_at DESC LIMIT 1`,[run.organization_id,run.user_id,trialId,build,JSON.stringify(run.photo_hashes)])).rows[0]:null;
  const grantCount=Array.isArray(trial.approved_photo_sets)&&trial.max_runs>trial.approved_photo_sets.length?Number((await c.query(`SELECT count(DISTINCT a.request_body->>'build_sha') AS n FROM audit_log a
   JOIN recognition_runs p ON p.id::text=a.request_body->>'prior_run_id'
   JOIN recognition_stability_runs s ON s.run_id=p.id AND s.trial_id=$3
   WHERE a.organization_id=$1 AND a.user_id=$2 AND a.action='Authorized recognition rerun'
    AND a.request_body->>'trial_id'=$3::text AND a.request_body->'photo_hashes'=p.photo_hashes
    AND a.request_body->>'build_sha' ~ '^[a-f0-9]{40}$'`,[run.organization_id,run.user_id,trialId])).rows[0].n):0;
  const setIndex=approvedPhotoSetIndex(trial,run.photo_hashes,grantCount);
  if(trial.approved_photo_sets!=null){
   const prior=await c.query(`SELECT r.id,r.stage_one FROM recognition_stability_runs s JOIN recognition_runs r ON r.id=s.run_id
    WHERE s.trial_id=$1 AND r.photo_hashes=$2::jsonb`,[trialId,JSON.stringify(run.photo_hashes)]);
   if(prior.rows.length&&(!replay||!prior.rows.some((r:any)=>r.id===replay.request_body.prior_run_id)||
     prior.rows.some((r:any)=>r.stage_one?.recognition_versions?.build_sha===build)))throw Error('stability_photo_set_already_run');
  }
  const count=Number((await c.query('SELECT count(*) AS n FROM recognition_stability_runs WHERE trial_id=$1',[trialId])).rows[0].n);
  if(count>=trial.max_runs)throw Error('stability_run_limit');
  await c.query('INSERT INTO recognition_stability_runs(trial_id,run_id,request_id) VALUES($1,$2,$3)',[trialId,runId,requestId]);
  if(trial.approved_photo_sets!=null)await c.query('UPDATE recognition_runs SET stage_one=stage_one || $2::jsonb WHERE id=$1',
   [runId,JSON.stringify({field_baseline_scope:{trial_id:trialId,set_index:setIndex,scope_sha256:trial.photo_sha256,photo_count:run.photo_hashes.length,...(replay?{replay_authorization_id:replay.id,prior_run_id:replay.request_body.prior_run_id}:{})}})]);
  return true;
 });if(!accepted)throw Error('stability_unknown_spend');
}
export async function reserveStabilityAttempt(attemptId:string,runId:string,maximum:number):Promise<boolean>{
 const trialId=stabilityTrialId();if(!trialId)return false;
 await transaction(async c=>{
  const trial=(await c.query('SELECT * FROM recognition_stability_trials WHERE id=$1 FOR UPDATE',[trialId])).rows[0];
  if(!trial||trial.state!=='open')throw Error('stability_trial_unavailable');
  const linked=(await c.query('SELECT 1 FROM recognition_stability_runs WHERE trial_id=$1 AND run_id=$2',[trialId,runId])).rows.length;
  if(!linked)throw Error('stability_run_not_registered');
  const used=Number((await c.query('SELECT COALESCE(sum(charged_micro),0) AS used FROM recognition_stability_reservations WHERE trial_id=$1',[trialId])).rows[0].used);
  if(!Number.isSafeInteger(maximum)||maximum<1||used+maximum>trial.cap_micro)throw Error('stability_budget_exhausted');
  await c.query('INSERT INTO recognition_stability_reservations(attempt_id,trial_id,maximum_micro,charged_micro) VALUES($1,$2,$3,$3)',[attemptId,trialId,maximum]);
 });return true;
}
export async function settleStabilityAttempt(attemptId:string,actual:number|null):Promise<void>{
 await transaction(async c=>{
  const ref=(await c.query('SELECT trial_id FROM recognition_stability_reservations WHERE attempt_id=$1',[attemptId])).rows[0];
  if(!ref)return;
  await c.query('SELECT id FROM recognition_stability_trials WHERE id=$1 FOR UPDATE',[ref.trial_id]);
  const reservation=(await c.query('SELECT * FROM recognition_stability_reservations WHERE attempt_id=$1',[attemptId])).rows[0];
  if(reservation.outcome!=='reserved')return; // a later recovery must not refund an unknown send
  if(actual===null||!Number.isSafeInteger(actual)||actual<0||actual>reservation.maximum_micro){
   await c.query("UPDATE recognition_stability_reservations SET outcome='unknown' WHERE attempt_id=$1",[attemptId]);
   await c.query("UPDATE recognition_stability_trials SET state='paused' WHERE id=$1",[ref.trial_id]);return;
  }
  // Zero usage is valid only when explicitly supplied, never inferred from an error.
  await c.query("UPDATE recognition_stability_reservations SET outcome='settled',charged_micro=$2 WHERE attempt_id=$1",[attemptId,actual]);
 });
}

// Only a complete, explicit account-limit rejection is eligible for review.
// This classification never releases money automatically.
export function accountLimitRejected(status:number,body:any):boolean {
 return [400,403].includes(status)&&body?.type==='error'&&body?.error?.type==='permission_error'
  &&typeof body.error.message==='string'&&/usage limit|spend(?:ing)? limit/i.test(body.error.message);
}
export async function reconcileRejectedAttempt(attemptId:string,actor:{userId:string;organizationId:string},evidence:string){
 if(!stabilityTrialId())throw Error('stability_trial_required');
 if(!evidence.trim()||evidence.length>1000)throw Error('stability_reconciliation_evidence_required');
 return transaction(async c=>{
  const user=(await c.query('SELECT role,is_active FROM users WHERE id=$1 AND organization_id=$2',[actor.userId,actor.organizationId])).rows[0];
  if(!user?.is_active||user.role!=='admin')throw Error('stability_reconciliation_forbidden');
  const ref=(await c.query('SELECT trial_id FROM recognition_stability_reservations WHERE attempt_id=$1',[attemptId])).rows[0];
  if(!ref||ref.trial_id!==stabilityTrialId())throw Error('stability_reconciliation_forbidden');
  const trial=(await c.query('SELECT * FROM recognition_stability_trials WHERE id=$1 FOR UPDATE',[ref.trial_id])).rows[0];
  if(trial.organization_id!==actor.organizationId)throw Error('stability_reconciliation_forbidden');
  const a=(await c.query('SELECT * FROM recognition_provider_attempts WHERE id=$1',[attemptId])).rows[0];
  if(a?.cost_status==='reviewed_uncharged')return {outcome:'already_reconciled'};
  const reservation=(await c.query('SELECT outcome FROM recognition_stability_reservations WHERE attempt_id=$1',[attemptId])).rows[0];
  if(reservation?.outcome!=='unknown')throw Error('stability_reconciliation_ineligible');
  const r=(await c.query('SELECT stage_one FROM recognition_runs WHERE id=$1',[a?.run_id])).rows[0];
  let body:any;try{body=JSON.parse(a?.raw_output);}catch{}
  const http=r?.stage_one?.[`provider_http_${attemptId}`]?.http_status;
  if(a?.outcome!=='rejected_uncharged_pending_review'||!accountLimitRejected(http,body))throw Error('stability_reconciliation_ineligible');
  const audit={attempt_id:attemptId,reviewer_id:actor.userId,evidence:evidence.trim(),reviewed_at:new Date().toISOString(),outcome:'reviewed_uncharged'};
  await c.query("UPDATE recognition_stability_reservations SET outcome='settled',charged_micro=0 WHERE attempt_id=$1 AND outcome='unknown'",[attemptId]);
  await c.query("UPDATE recognition_provider_attempts SET cost_usd=0,cost_status='reviewed_uncharged' WHERE id=$1",[attemptId]);
  await c.query('UPDATE recognition_runs SET stage_one=stage_one || $2::jsonb WHERE id=$1',[a.run_id,JSON.stringify({[`reconciliation_${attemptId}`]:audit})]);
  // A reviewed refund does not reopen a trial or permit automatic retries.
  return {outcome:'reviewed_uncharged'};
 });
}
