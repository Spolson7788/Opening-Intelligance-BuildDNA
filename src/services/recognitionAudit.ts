import {AsyncLocalStorage} from 'node:async_hooks';
import {pool} from '../db/pool';
import {createHash,randomUUID} from 'node:crypto';

interface AuditContext {runId:string;deadline:number;signal?:AbortSignal}
export const recognitionAudit=new AsyncLocalStorage<AuditContext>();
// Persist before sending. If accounting is unavailable, do not make a paid call.
// Usage/cost remain unknown on interrupted responses; never report them as zero.
export async function auditedFetch(url:string,init:RequestInit,stage:string):Promise<Response>{
 const context=recognitionAudit.getStore();
 if(!context)return fetch(url,init);
 const request=JSON.parse(String(init.body||'{}'));
 const id=randomUUID(),started=Date.now();
 if(started>=context.deadline)throw new DOMException('Recognition deadline','TimeoutError');
 await pool.query(`INSERT INTO recognition_provider_attempts(id,run_id,stage,provider,model_id,outcome,request_manifest) VALUES($1,$2,$3,'anthropic',$4,'started',$5)`,[id,context.runId,stage,request.model,JSON.stringify((request.messages||[]).map((m:any)=>({...m,content:(m.content||[]).map((c:any)=>c.type==='image'?{type:'image',media_type:c.source?.media_type,sha256:createHash('sha256').update(Buffer.from(c.source?.data||'','base64')).digest('hex')}:c)})))]);
 const deadlineSignal=AbortSignal.timeout(Math.max(1,context.deadline-Date.now()));
 const signal=AbortSignal.any([deadlineSignal,...(init.signal?[init.signal]:[]),...(context.signal?[context.signal]:[])]);
 try{
  signal.throwIfAborted();
  const response=await fetch(url,{...init,signal});
  const raw=await response.text();
  let body:any;try{body=JSON.parse(raw);}catch{}
  const usage=body?.usage||null;
  let validOutput=false;
  try{const text=(body?.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('');JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));validOutput=true;}catch{}
  const input=Number(process.env.OI_PROVIDER_INPUT_USD_PER_MILLION),output=Number(process.env.OI_PROVIDER_OUTPUT_USD_PER_MILLION);
  const priced=usage&&Number.isFinite(input)&&Number.isFinite(output)&&input>0&&output>0&&!usage.cache_creation_input_tokens&&!usage.cache_read_input_tokens;
  const cost=priced?(usage.input_tokens*input+usage.output_tokens*output)/1e6:null;
  await pool.query(`UPDATE recognition_provider_attempts SET outcome=$2,latency_ms=$3,usage=$4,cost_usd=$5,cost_status=$6,raw_output=$7,cost_basis=$8,finished_at=now() WHERE id=$1`,[id,response.ok?(validOutput?'response_received':'invalid_response'):'provider_error',Date.now()-started,JSON.stringify(usage),cost,priced?'estimated':'unknown',raw,priced?JSON.stringify({input_usd_per_million:input,output_usd_per_million:output,model:request.model}):null]);
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
