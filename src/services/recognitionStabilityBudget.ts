import {pool} from '../db/pool';
import {AsyncLocalStorage} from 'node:async_hooks';

// Populated only by the Netlify handler from its trusted request context.
export const stabilityRuntime=new AsyncLocalStorage<string|undefined>();
function stabilityEnv(key:string):string|undefined {
 const netlify=(globalThis as any).Netlify;
 if(netlify?.env?.get)return netlify.env.get(key);
 return process.env.NODE_ENV==='test'?process.env[key]:undefined;
}

// This guard is deliberately limited to the existing direct Sonnet 4.5 request.
// Its 200K context ceiling, rather than an estimated token count, bounds input.
// Pricing checked 2026-10-05: standard direct API $3/M input and $15/M output.
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
export function stabilityMaximum(request:any,url:string,headers:HeadersInit|undefined):number {
 const h=new Headers(headers);
 if(url!=='https://api.anthropic.com/v1/messages'||h.has('anthropic-beta'))throw Error('stability_request_unsupported');
 if(request.model!==STABILITY_MODEL || !Number.isSafeInteger(request.max_tokens) || request.max_tokens<1 || request.max_tokens>2500)throw Error('stability_request_unsupported');
 if(Object.keys(request).some(k=>!['model','max_tokens','temperature','messages'].includes(k)))throw Error('stability_request_unsupported');
 if(!Array.isArray(request.messages)||request.messages.some((m:any)=>m.role!=='user'||!Array.isArray(m.content)||m.content.some((b:any)=>!['text','image'].includes(b.type)||b.cache_control)))throw Error('stability_request_unsupported');
 return STABILITY_INPUT_CEILING*3+request.max_tokens*15; // integer micro-dollars
}
export function stabilityActual(usage:any,maxTokens:number):number|null {
 const valid=(n:any)=>Number.isSafeInteger(n)&&n>=0;
 if(!usage||!valid(usage.input_tokens)||!valid(usage.output_tokens)||usage.input_tokens>STABILITY_INPUT_CEILING||usage.output_tokens>maxTokens)return null;
 if(usage.cache_creation_input_tokens||usage.cache_read_input_tokens||usage.server_tool_use)return null;
 return usage.input_tokens*3+usage.output_tokens*15;
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
  if(!run||run.organization_id!==trial.organization_id||run.user_id!==trial.user_id||run.opening_id!==trial.opening_id||!Array.isArray(run.photo_hashes)||run.photo_hashes.length!==1||run.photo_hashes[0]!==trial.photo_sha256)throw Error('stability_trial_scope_mismatch');
  const count=Number((await c.query('SELECT count(*) AS n FROM recognition_stability_runs WHERE trial_id=$1',[trialId])).rows[0].n);
  if(count>=trial.max_runs)throw Error('stability_run_limit');
  await c.query('INSERT INTO recognition_stability_runs(trial_id,run_id,request_id) VALUES($1,$2,$3)',[trialId,runId,requestId]);
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
