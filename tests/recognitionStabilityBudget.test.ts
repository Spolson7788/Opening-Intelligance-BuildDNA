import {claimReaderStage,validateStageResume,stagedInputKey} from '../src/services/recognitionStages';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
const fixture=vi.hoisted(()=>({db:null as any,queue:Promise.resolve()}));
// PGlite owns one session: serialize test transactions, as its socket adapter does.
vi.mock('../src/db/pool',()=>({pool:{query:(sql:string,args:any[])=>fixture.db.query(sql,args),connect:async()=>{
 const prior=fixture.queue;let release!:()=>void;fixture.queue=new Promise<void>(r=>release=r);await prior;
 return {query:(sql:string,args:any[])=>fixture.db.query(sql,args),release};
}}}));
vi.mock('../src/services/recognitionImage',()=>({prepareProviderRequest:async(request:any)=>({body:JSON.stringify(request),manifest:[]})}));
import {registerStabilityRun,reserveStabilityAttempt,settleStabilityAttempt,stabilityMaximum,stabilityActual,stabilityTrialId,stabilityRuntime,STABILITY_MODEL,reconcileRejectedAttempt,accountLimitRejected,approvedPhotoSetIndex} from '../src/services/recognitionStabilityBudget';
import {recognitionAudit,auditedFetch} from '../src/services/recognitionAudit';
const org=randomUUID(),actor=randomUUID(),opening=randomUUID(),trial=randomUUID(),hash='4f46d88ad71d97bb9aff870efa56eccc82de8b17aafa8b381994e86c969b668f';
const body=()=>({model:STABILITY_MODEL,max_tokens:1600,temperature:0,messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]});
beforeAll(async()=>{
 fixture.db=new PGlite();
 await fixture.db.exec(`CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid,role text,is_active boolean);CREATE TABLE openings(id uuid PRIMARY KEY);
 CREATE TABLE audit_log(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,action text,request_body jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE recognition_runs(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,opening_id uuid,photo_hashes jsonb,status text,stage_one jsonb DEFAULT '{}');
 CREATE TABLE recognition_provider_attempts(id uuid PRIMARY KEY,run_id uuid REFERENCES recognition_runs(id),stage text,provider text,model_id text,outcome text,started_at timestamptz DEFAULT now(),finished_at timestamptz,request_manifest jsonb,latency_ms integer,usage jsonb,cost_usd numeric,cost_status text,raw_output text,cost_basis jsonb);`);
 await fixture.db.exec(readFileSync(new URL('../migrations/20261005170938_recognition_stability_budget.sql',import.meta.url),'utf8'));
 await fixture.db.exec(readFileSync(new URL('../migrations/20261007132028_field_photo_trial_scope.sql',import.meta.url),'utf8'));
 await fixture.db.query('INSERT INTO organizations VALUES($1)',[org]);await fixture.db.query('INSERT INTO users VALUES($1,$2,$3,true)',[actor,org,'admin']);await fixture.db.query('INSERT INTO openings VALUES($1)',[opening]);
},20000);
beforeEach(async()=>{
 await fixture.db.exec('TRUNCATE audit_log,recognition_stability_reservations,recognition_stability_runs,recognition_stability_trials,recognition_provider_attempts,recognition_runs');
 await fixture.db.query('INSERT INTO recognition_stability_trials(id,organization_id,user_id,opening_id,photo_sha256) VALUES($1,$2,$3,$4,$5)',[trial,org,actor,opening,hash]);
 process.env.OI_STABILITY_TRIAL_REQUIRED='true';process.env.OI_STABILITY_TRIAL_ID=trial;process.env.OI_STABILITY_LOCAL_TEST='true';
});
afterEach(()=>{for(const k of ['OI_STABILITY_TRIAL_REQUIRED','OI_STABILITY_TRIAL_ID','OI_STABILITY_LOCAL_TEST','CONTEXT'])delete process.env[k];vi.unstubAllGlobals();});
afterAll(async()=>fixture.db?.close());
async function run(overrides:any={}){const id=randomUUID();await fixture.db.query('INSERT INTO recognition_runs(id,organization_id,user_id,opening_id,photo_hashes,status) VALUES($1,$2,$3,$4,$5,$6)',[id,overrides.organization_id||org,overrides.user_id||actor,overrides.opening_id||opening,JSON.stringify(overrides.photo_hashes||[hash]),'running']);return id;}
async function registered(){const id=await run();await registerStabilityRun(id,randomUUID());return id;}
async function attempt(runId:string){const id=randomUUID();await fixture.db.query("INSERT INTO recognition_provider_attempts(id,run_id,outcome) VALUES($1,$2,'started')",[id,runId]);return id;}
async function used(){return Number((await fixture.db.query('SELECT COALESCE(sum(charged_micro),0) AS n FROM recognition_stability_reservations')).rows[0].n);}
it('uses a full context ceiling and maximum output rather than optimistic input estimates',()=>expect(stabilityMaximum(body(),'https://api.anthropic.com/v1/messages',{})).toBe(624000));
it.each(['model','max_tokens','tools','service_tier','thinking'])('refuses unsupported request configuration %s',key=>{const b:any=body();b[key]=key==='max_tokens'?3000:'unsupported';expect(()=>stabilityMaximum(b,'https://api.anthropic.com/v1/messages',{})).toThrow();});
it('refuses beta context expansion and other provider destinations',()=>{expect(()=>stabilityMaximum(body(),'https://api.anthropic.com/v1/messages',{'anthropic-beta':'context-1m'})).toThrow();expect(()=>stabilityMaximum(body(),'https://other.example/messages',{})).toThrow();});
it('fails closed when configuration is missing or runtime is production',()=>{delete process.env.OI_STABILITY_TRIAL_ID;expect(()=>stabilityTrialId()).toThrow();process.env.OI_STABILITY_TRIAL_ID=trial;expect(()=>stabilityRuntime.run('production',stabilityTrialId)).toThrow();});
it('uses trusted runtime context rather than a build-only environment variable',()=>{delete process.env.OI_STABILITY_LOCAL_TEST;process.env.CONTEXT='deploy-preview';expect(()=>stabilityTrialId()).toThrow();expect(stabilityRuntime.run('deploy-preview',stabilityTrialId)).toBe(trial);expect(()=>stabilityRuntime.run('branch-deploy',stabilityTrialId)).toThrow();});
it('reads deployed flags through the Netlify runtime environment API',()=>{const get=vi.fn((key:string)=>key==='OI_STABILITY_TRIAL_REQUIRED'?'true':key==='OI_STABILITY_TRIAL_ID'?trial:undefined);vi.stubGlobal('Netlify',{env:{get}});process.env.OI_STABILITY_TRIAL_ID='invalid';expect(stabilityRuntime.run('deploy-preview',stabilityTrialId)).toBe(trial);expect(get).toHaveBeenCalledWith('OI_STABILITY_TRIAL_ID');});
it('refuses preview provider work when the required trial flag is missing',()=>{delete process.env.OI_STABILITY_TRIAL_REQUIRED;expect(()=>stabilityRuntime.run('deploy-preview',stabilityTrialId)).toThrow('not_configured');expect(stabilityRuntime.run('production',stabilityTrialId)).toBeNull();});
it.each(['user_id','opening_id','organization_id','photo_hashes'])('requires approved scope %s',async key=>{const id=await run({[key]:key==='photo_hashes'?['0'.repeat(64)]:randomUUID()});await expect(registerStabilityRun(id,randomUUID())).rejects.toThrow('scope_mismatch');});
it('requires request IDs and prevents resubmitting a paid run',async()=>{const id=await run();await expect(registerStabilityRun(id,undefined)).rejects.toThrow();const request=randomUUID();await registerStabilityRun(id,request);await expect(registerStabilityRun(await run(),request)).rejects.toThrow();});
it('admits at most ten runs',async()=>{for(let i=0;i<10;i++)await registered();await expect(registered()).rejects.toThrow('run_limit');});
it('does not exceed $2 when competing attempts reserve budget',async()=>{const id=await registered();const ids=await Promise.all(Array.from({length:4},()=>attempt(id)));const outcomes=await Promise.allSettled(ids.map(a=>reserveStabilityAttempt(a,id,624000)));expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(3);expect(await used()).toBe(1872000);});
it('releases only verified unused budget and settlement is idempotent',async()=>{const id=await registered(),a=await attempt(id);await reserveStabilityAttempt(a,id,624000);await settleStabilityAttempt(a,180);await settleStabilityAttempt(a,0);expect(await used()).toBe(180);});
it('preserves unknown reservations and blocks further runs and attempts',async()=>{const id=await registered(),a=await attempt(id);await reserveStabilityAttempt(a,id,624000);await settleStabilityAttempt(a,null);await settleStabilityAttempt(a,0);expect(await used()).toBe(624000);await expect(registered()).rejects.toThrow('unavailable');await expect(reserveStabilityAttempt(await attempt(id),id,624000)).rejects.toThrow('unavailable');});
it('detects crash leftovers on the next run without refunding them',async()=>{const id=await registered(),a=await attempt(id);await reserveStabilityAttempt(a,id,624000);await fixture.db.query("UPDATE recognition_provider_attempts SET started_at=now()-interval '2 minutes' WHERE id=$1",[a]);await expect(registered()).rejects.toThrow('unknown_spend');expect(await used()).toBe(624000);expect((await fixture.db.query('SELECT state FROM recognition_stability_trials')).rows[0].state).toBe('paused');});
it('treats absent or cached usage as unknown, never zero',()=>{expect(stabilityActual(null,1600)).toBeNull();expect(stabilityActual({input_tokens:1,output_tokens:1,cache_read_input_tokens:1},1600)).toBeNull();expect(stabilityActual({input_tokens:200001,output_tokens:1},1600)).toBeNull();expect(stabilityActual({input_tokens:0,output_tokens:0},1600)).toBe(0);});
it('records budget before fetch and settles explicit provider usage',async()=>{const id=await registered();const fetch=vi.fn(async()=>{expect(await used()).toBe(624000);return Response.json({content:[{type:'text',text:'{}'}],usage:{input_tokens:10,output_tokens:10}});});vi.stubGlobal('fetch',fetch);await recognitionAudit.run({runId:id,deadline:Date.now()+10000},()=>auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'fixture'));expect(fetch).toHaveBeenCalledTimes(1);expect(await used()).toBe(180);
 const evidence=(await fixture.db.query('SELECT stage_one FROM recognition_runs WHERE id=$1',[id])).rows[0].stage_one;
 const http=Object.values(evidence)[0] as any;expect(http).toMatchObject({http_status:200,stage:'fixture'});expect(http.started_at).toBeTruthy();expect(http.finished_at).toBeTruthy();expect(http.latency_ms).toBeGreaterThanOrEqual(0);
});
it('does not send when remaining budget cannot cover the maximum request',async()=>{const id=await registered(),a=await attempt(id);await reserveStabilityAttempt(a,id,1900000);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(recognitionAudit.run({runId:id,deadline:Date.now()+10000},()=>auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'fixture'))).rejects.toThrow('exhausted');expect(fetch).not.toHaveBeenCalled();});
it('retains the ceiling and pauses after an interrupted send',async()=>{const id=await registered();const fetch=vi.fn(async()=>{throw new TypeError('response lost');});vi.stubGlobal('fetch',fetch);await expect(recognitionAudit.run({runId:id,deadline:Date.now()+10000},()=>auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'fixture'))).rejects.toThrow('response lost');expect(await used()).toBe(624000);await expect(registered()).rejects.toThrow('unavailable');});

it('pauses on a complete account-limit error and blocks subsequent stages without refund',async()=>{
 const id=await registered();const fetch=vi.fn().mockResolvedValue(Response.json({type:'error',error:{type:'permission_error',message:'Your API usage limits have been reached'}},{status:403}));vi.stubGlobal('fetch',fetch);
 await recognitionAudit.run({runId:id,deadline:Date.now()+10000,trialControl:{}},async()=>{
  const response=await auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'photo_analysis');expect(response.status).toBe(403);
  await expect(auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'label_locator')).rejects.toThrow('account_limit');
 });
 expect(fetch).toHaveBeenCalledTimes(1);expect(await used()).toBe(624000);
 const a=(await fixture.db.query('SELECT * FROM recognition_provider_attempts')).rows[0];expect(a.outcome).toBe('rejected_uncharged_pending_review');
 await expect(reconcileRejectedAttempt(a.id,{userId:randomUUID(),organizationId:org},'billing evidence')).rejects.toThrow('forbidden');
 await reconcileRejectedAttempt(a.id,{userId:actor,organizationId:org},'Provider failed-request billing policy and complete account-limit error reviewed');
 expect(await used()).toBe(0);expect((await fixture.db.query('SELECT state FROM recognition_stability_trials')).rows[0].state).toBe('paused');
 expect((await fixture.db.query('SELECT stage_one FROM recognition_runs')).rows[0].stage_one['reconciliation_'+a.id]).toMatchObject({reviewer_id:actor,outcome:'reviewed_uncharged'});
 expect(await reconcileRejectedAttempt(a.id,{userId:actor,organizationId:org},'same evidence')).toEqual({outcome:'already_reconciled'});
});
it('cannot reconcile a lost response or infer that generic errors are free',async()=>{
 expect(accountLimitRejected(429,{type:'error',error:{type:'permission_error',message:'usage limit'}})).toBe(false);
 expect(accountLimitRejected(403,{type:'error',error:{type:'permission_error',message:'access denied'}})).toBe(false);
 const id=await registered(),a=await attempt(id);await reserveStabilityAttempt(a,id,624000);await settleStabilityAttempt(a,null);
 await expect(reconcileRejectedAttempt(a,{userId:actor,organizationId:org},'unverified')).rejects.toThrow('ineligible');expect(await used()).toBe(624000);
});
it('settles each sequenced call so a $1.45 remaining allowance can cover ten realistic attempts',async()=>{
 await fixture.db.query('UPDATE recognition_stability_trials SET cap_micro=1457513');
 for(let n=0;n<10;n++){const id=await registered();for(let j=0;j<4;j++){const a=await attempt(id);await reserveStabilityAttempt(a,id,624000);await settleStabilityAttempt(a,15000);}}
 expect(await used()).toBe(600000);
});
const fieldSets=()=>[['a','b','c'],['d','e','f']].map(s=>s.map(h=>h.repeat(64)));
const digest=(sets:unknown)=>createHash('sha256').update(JSON.stringify(sets)).digest('hex');
it('accepts each complete frozen multi-view set once and retains the shared budget',async()=>{
 const sets=fieldSets();await fixture.db.query('UPDATE recognition_stability_trials SET approved_photo_sets=$1,photo_sha256=$2,max_runs=2,cap_micro=1411028',[JSON.stringify(sets),digest(sets)]);
 const first=await run({photo_hashes:sets[0]});await registerStabilityRun(first,randomUUID());
 const evidence=(await fixture.db.query('SELECT stage_one FROM recognition_runs WHERE id=$1',[first])).rows[0].stage_one;
 expect(evidence.field_baseline_scope).toMatchObject({set_index:0,photo_count:3,scope_sha256:digest(sets)});
 await expect(registerStabilityRun(await run({photo_hashes:sets[0]}),randomUUID())).rejects.toThrow('already_run');
 const second=await run({photo_hashes:sets[1]});await registerStabilityRun(second,randomUUID());
 const a=await attempt(first);await reserveStabilityAttempt(a,first,624000);await settleStabilityAttempt(a,100000);
 expect(await used()).toBe(100000);
 const b=await attempt(second);await reserveStabilityAttempt(b,second,624000);await settleStabilityAttempt(b,100000);
 expect(await used()).toBe(200000);
});
it('rejects mixed, omitted, reordered and extra photos even when individual hashes are approved',()=>{
 const sets=fieldSets(),t={approved_photo_sets:sets,photo_sha256:digest(sets),max_runs:2};
 expect(approvedPhotoSetIndex(t,sets[1])).toBe(1);
 for(const bad of [[sets[0][0],sets[1][1],sets[0][2]],sets[0].slice(1),[...sets[0]].reverse(),[...sets[0],sets[1][0]]])
  expect(()=>approvedPhotoSetIndex(t,bad)).toThrow('scope_mismatch');
 expect(()=>approvedPhotoSetIndex({...t,photo_sha256:'0'.repeat(64)},sets[0])).toThrow();
 expect(()=>approvedPhotoSetIndex({...t,max_runs:3},sets[0])).toThrow();
});
it('rejects malformed frozen scope while legacy single-photo trials remain supported',()=>{
 for(const sets of [[],[[]],[[hash,hash,hash]],[[hash,'x','y']],Array(11).fill([hash]),'bad'])
  expect(()=>approvedPhotoSetIndex({approved_photo_sets:sets,photo_sha256:digest(sets),max_runs:1},[hash])).toThrow();
 expect(approvedPhotoSetIndex({approved_photo_sets:null,photo_sha256:hash},[hash])).toBe(0);
});


it('allows one explicit build-bound replay, rejects another build and duplicate replay, and keeps the ledger',async()=>{
 const sets=fieldSets(),build='a'.repeat(40);
 await fixture.db.query('UPDATE recognition_stability_trials SET approved_photo_sets=$2,photo_sha256=$3,max_runs=2 WHERE id=$1',[trial,JSON.stringify(sets),digest(sets)]);
 const prior=await run({photo_hashes:sets[1]});await registerStabilityRun(prior,randomUUID());
 const a=await attempt(prior);await reserveStabilityAttempt(a,prior,624000);await settleStabilityAttempt(a,100000);
 await fixture.db.query('UPDATE recognition_stability_trials SET max_runs=3 WHERE id=$1',[trial]);
 const candidate=await run({photo_hashes:sets[1]});
 await fixture.db.query('UPDATE recognition_runs SET stage_one=$2 WHERE id=$1',[candidate,JSON.stringify({recognition_versions:{build_sha:build}})]);
 await expect(registerStabilityRun(candidate,randomUUID())).rejects.toThrow('scope_mismatch');
 await fixture.db.query('INSERT INTO audit_log VALUES($1,$2,$3,$4,$5,now())',[randomUUID(),org,actor,'Authorized recognition rerun',JSON.stringify({trial_id:trial,build_sha:build,photo_hashes:sets[1],prior_run_id:prior})]);
 const wrong=await run({photo_hashes:sets[1]});
 await fixture.db.query('UPDATE recognition_runs SET stage_one=$2 WHERE id=$1',[wrong,JSON.stringify({recognition_versions:{build_sha:'b'.repeat(40)}})]);
 await expect(registerStabilityRun(wrong,randomUUID())).rejects.toThrow('scope_mismatch');
 await registerStabilityRun(candidate,randomUUID());
 expect(await used()).toBe(100000);
 const duplicate=await run({photo_hashes:sets[1]});
 await fixture.db.query('UPDATE recognition_runs SET stage_one=$2 WHERE id=$1',[duplicate,JSON.stringify({recognition_versions:{build_sha:build}})]);
 await expect(registerStabilityRun(duplicate,randomUUID())).rejects.toThrow('already_run');
});
it('requires a distinct valid audited grant for each additional build comparison',async()=>{
 const sets=fieldSets();
 await fixture.db.query('UPDATE recognition_stability_trials SET approved_photo_sets=$2,photo_sha256=$3,max_runs=2 WHERE id=$1',[trial,JSON.stringify(sets),digest(sets)]);
 const prior=await run({photo_hashes:sets[1]});await registerStabilityRun(prior,randomUUID());
 const first='a'.repeat(40),second='b'.repeat(40);
 await fixture.db.query('INSERT INTO audit_log VALUES($1,$2,$3,$4,$5,now())',[randomUUID(),org,actor,'Authorized recognition rerun',JSON.stringify({trial_id:trial,build_sha:first,photo_hashes:sets[1],prior_run_id:prior})]);
 await fixture.db.query('UPDATE recognition_stability_trials SET max_runs=3 WHERE id=$1',[trial]);
 const firstRun=await run({photo_hashes:sets[1]});await fixture.db.query('UPDATE recognition_runs SET stage_one=$2 WHERE id=$1',[firstRun,JSON.stringify({recognition_versions:{build_sha:first}})]);await registerStabilityRun(firstRun,randomUUID());
 await fixture.db.query('UPDATE recognition_stability_trials SET max_runs=4 WHERE id=$1',[trial]);
 const secondRun=await run({photo_hashes:sets[1]});await fixture.db.query('UPDATE recognition_runs SET stage_one=$2 WHERE id=$1',[secondRun,JSON.stringify({recognition_versions:{build_sha:second}})]);
 await expect(registerStabilityRun(secondRun,randomUUID())).rejects.toThrow('scope_mismatch');
 await fixture.db.query('INSERT INTO audit_log VALUES($1,$2,$3,$4,$5,now())',[randomUUID(),org,actor,'Authorized recognition rerun',JSON.stringify({trial_id:trial,build_sha:second,photo_hashes:sets[1],prior_run_id:firstRun})]);
 await registerStabilityRun(secondRun,randomUUID());expect(await used()).toBe(0);
});
it('stops the in-flight pipeline after an interrupted paid call without a second provider attempt',async()=>{
 const id=await registered();const control:{stopped?:boolean}={};
 const fetch=vi.fn(async()=>{throw new DOMException('provider timed out','TimeoutError');});vi.stubGlobal('fetch',fetch);
 await recognitionAudit.run({runId:id,deadline:Date.now()+10000,trialControl:control},async()=>{
  await expect(auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'label_locator')).rejects.toThrow('timed out');
  expect(control.stopped).toBe(true);
  await expect(auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'photo_analysis')).rejects.toThrow('label_account_limit');
 });
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(Number((await fixture.db.query('SELECT count(*) AS n FROM recognition_provider_attempts')).rows[0].n)).toBe(1);
 expect(await used()).toBe(624000);
});

it('allows exactly one reader-stage claim and preserves the active lease on duplicate requests',async()=>{
 const id=randomUUID(),build='b'.repeat(40),key='c'.repeat(64);const regions=[{photo_index:0,x:.1,y:.1,w:.4,h:.2,rotation:0,kind:'product_label'}];
 await fixture.db.query("INSERT INTO recognition_runs(id,organization_id,user_id,opening_id,photo_hashes,status,stage_one) VALUES($1,$2,$3,$4,$5,'running',$6)",[id,org,actor,opening,JSON.stringify([hash]),JSON.stringify({recognition_versions:{build_sha:build},staged_execution:{phase:'readers_ready',input_key:key},label_reading:{planned_regions:regions}})]);
 const scope={organizationId:org,userId:actor,openingId:opening};
 const claims=await Promise.allSettled([claimReaderStage(id,scope,build,key),claimReaderStage(id,scope,build,key)]);
 expect(claims.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(claims.filter(r=>r.status==='rejected')).toHaveLength(1);
 const row=(await fixture.db.query('SELECT * FROM recognition_runs WHERE id=$1',[id])).rows[0];expect(row.status).toBe('running');expect(row.stage_one.staged_execution.phase).toBe('reading');expect(row.stage_one.staged_execution.lease_token).toMatch(/^[a-f0-9-]{36}$/);expect(row.stage_one.label_reading.planned_regions).toEqual(regions);
});
it('does not resume an expired active stage or changed ownership, build, inputs or missing evidence',()=>{
 const run={organization_id:org,user_id:actor,opening_id:opening,status:'running',stage_one:{recognition_versions:{build_sha:'build'},staged_execution:{phase:'readers_ready',input_key:'key'},label_reading:{planned_regions:[{}]}}};
 const scope={organizationId:org,userId:actor,openingId:opening};
 expect(()=>validateStageResume(run,{...scope,userId:randomUUID()},'build','key')).toThrow('recognition_stage_not_found');
 expect(()=>validateStageResume(run,scope,'different','key')).toThrow('recognition_stage_input_changed');expect(()=>validateStageResume(run,scope,'build','different')).toThrow('recognition_stage_input_changed');
 for(const phase of ['locating','reading','focusing'])expect(()=>validateStageResume({...run,stage_one:{...run.stage_one,staged_execution:{phase,input_key:'key',started_at:'2000-01-01'}}},scope,'build','key')).toThrow('recognition_stage_not_resumable');
 expect(()=>validateStageResume({...run,stage_one:{...run.stage_one,trial_stop:{reason:'provider_response_interrupted'}}},scope,'build','key')).toThrow('recognition_stage_not_resumable');expect(()=>validateStageResume({...run,status:'failed'},scope,'build','key')).toThrow('recognition_stage_not_resumable');expect(()=>validateStageResume({...run,stage_one:{...run.stage_one,label_reading:{planned_regions:[]}}},scope,'build','key')).toThrow('recognition_stage_evidence_missing');
});
it('binds staged inputs to request, ordered original IDs and technician attributes',()=>{
 const b={opening_id:opening,photo_ids:['one','two','three'],media_type:'image/jpeg',request_id:'request',technician_attributes:{component_type:'exit_device',component_type_source:'technician'}};
 expect(stagedInputKey(b)).toBe(stagedInputKey({...b,technician_attributes:{component_type_source:'technician',component_type:'exit_device'}}));
 for(const changed of [{...b,request_id:'other'},{...b,photo_ids:['three','two','one']},{...b,media_type:'image/png'},{...b,technician_attributes:{...b.technician_attributes,component_type:'closer'}}])expect(stagedInputKey(changed)).not.toBe(stagedInputKey(b));
});

it('focus-stage claims are single-use and keep the first reader evidence intact',async()=>{
 const id=randomUUID(),build='d'.repeat(40),key='e'.repeat(64);const labels={reads:[{region:{photo_index:0,x:.1,y:.1,w:.1,h:.1,rotation:0,kind:'brand_mark'},provenance:{source:'native_tile',target_device:true,box:{x:.1,y:.1,w:.1,h:.1}}}]};
 await fixture.db.query("INSERT INTO recognition_runs(id,organization_id,user_id,opening_id,photo_hashes,status,stage_one) VALUES($1,$2,$3,$4,$5,'running',$6)",[id,org,actor,opening,JSON.stringify([hash]),JSON.stringify({recognition_versions:{build_sha:build},staged_execution:{phase:'focus_ready',input_key:key},label_reading:labels})]);
 const scope={organizationId:org,userId:actor,openingId:opening};const result=await claimReaderStage(id,scope,build,key);expect(result.mode).toBe('focus');expect(result.labels).toEqual(labels);
 await expect(claimReaderStage(id,scope,build,key)).rejects.toThrow('recognition_stage_not_resumable');const row=(await fixture.db.query('SELECT * FROM recognition_runs WHERE id=$1',[id])).rows[0];expect(row.stage_one.staged_execution.phase).toBe('focusing');expect(row.stage_one.label_reading).toEqual(labels);
});
