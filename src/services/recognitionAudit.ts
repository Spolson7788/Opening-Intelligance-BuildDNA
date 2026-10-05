import {providerObject} from './providerReply';
import {prepareProviderRequest} from './recognitionImage';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pool} from '../db/pool';
import {randomUUID} from 'node:crypto';

interface AuditContext {runId:string;deadline:number;signal?:AbortSignal}
export const recognitionAudit=new AsyncLocalStorage<AuditContext>();
// Persist before sending. If accounting is unavailable, do not make a paid call.
// Usage/cost remain unknown on interrupted responses; never report them as zero.
export async function auditedFetch(url:string,init:RequestInit,stage:string,validateOutput?:(body:any)=>unknown):Promise<Response>{
 const context=recognitionAudit.getStore();
 if(!context)throw Error('recognition_audit_context_required');
 const request=JSON.parse(String(init.body||'{}'));
 const id=randomUUID(),started=Date.now();
 if(started>=context.deadline)throw new DOMException('Recognition deadline','TimeoutError');
 await pool.query(`INSERT INTO recognition_provider_attempts(id,run_id,stage,provider,model_id,outcome) VALUES($1,$2,$3,'anthropic',$4,'started')`,[id,context.runId,stage,request.model]);
 const deadlineSignal=AbortSignal.timeout(Math.max(1,context.deadline-Date.now()));
 const signal=AbortSignal.any([deadlineSignal,...(init.signal?[init.signal]:[]),...(context.signal?[context.signal]:[])]);
 try{
  signal.throwIfAborted();
  const prepared=await prepareProviderRequest(request);
  await pool.query('UPDATE recognition_provider_attempts SET request_manifest=$2 WHERE id=$1',[id,JSON.stringify(prepared.manifest)]);
  signal.throwIfAborted();
  const response=await fetch(url,{...init,body:prepared.body,signal});
  const raw=await response.text();
  let body:any;try{body=JSON.parse(raw);}catch{}
  const usage=body?.usage||null;
  let validOutput=false;
  try{providerObject(body);if(validateOutput)validateOutput(body);validOutput=true;}catch{}
  const input=Number(process.env.OI_PROVIDER_INPUT_USD_PER_MILLION),output=Number(process.env.OI_PROVIDER_OUTPUT_USD_PER_MILLION);
  const validTokens=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const priced=usage&&validTokens(usage.input_tokens)&&validTokens(usage.output_tokens)&&Number.isFinite(input)&&Number.isFinite(output)&&input>0&&output>0&&!usage.cache_creation_input_tokens&&!usage.cache_read_input_tokens;
  const estimate=priced?(usage.input_tokens*input+usage.output_tokens*output)/1e6:null;
  const cost=estimate!==null&&Number.isFinite(estimate)?estimate:null;
  await pool.query(`UPDATE recognition_provider_attempts SET outcome=$2,latency_ms=$3,usage=$4,cost_usd=$5,cost_status=$6,raw_output=$7,cost_basis=$8,finished_at=now() WHERE id=$1`,[id,response.ok?(validOutput?'response_received':'invalid_response'):'provider_error',Date.now()-started,JSON.stringify(usage),cost,cost!==null?'estimated':'unknown',raw,cost!==null?JSON.stringify({input_usd_per_million:input,output_usd_per_million:output,model:request.model}):null]);
  return new Response(raw,{status:response.status,statusText:response.statusText,headers:response.headers});
 }catch(error){
  await pool.query(`UPDATE recognition_provider_attempts SET outcome=$2,latency_ms=$3,finished_at=now() WHERE id=$1`,[id,signal.aborted?'timeout':'error',Date.now()-started]);
  throw error;
 }
}

export async function recordRecognitionEvidence(key:string,value:unknown){
 const context=recognitionAudit.getStore();
 if(context)await pool.query('UPDATE recognition_runs SET stage_one=stage_one || $2::jsonb WHERE id=$1',[context.runId,JSON.stringify({[key]:value})]);
}
