import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const fixture=vi.hoisted(()=>({db:null as any,queue:Promise.resolve()}));
// PGlite owns one session: serialize test transactions, as its socket adapter does.
vi.mock('../src/db/pool',()=>({pool:{query:(sql:string,args:any[])=>fixture.db.query(sql,args),connect:async()=>{
 const prior=fixture.queue;let release!:()=>void;fixture.queue=new Promise<void>(r=>release=r);await prior;
 return {query:(sql:string,args:any[])=>fixture.db.query(sql,args),release};
}}}));
vi.mock('../src/services/recognitionImage',()=>({prepareProviderRequest:async(request:any)=>({body:JSON.stringify(request),manifest:[]})}));
import {registerStabilityRun,reserveStabilityAttempt,settleStabilityAttempt,stabilityMaximum,stabilityActual,stabilityTrialId,stabilityRuntime,STABILITY_MODEL} from '../src/services/recognitionStabilityBudget';
import {recognitionAudit,auditedFetch} from '../src/services/recognitionAudit';
const org=randomUUID(),actor=randomUUID(),opening=randomUUID(),trial=randomUUID(),hash='4f46d88ad71d97bb9aff870efa56eccc82de8b17aafa8b381994e86c969b668f';
const body=()=>({model:STABILITY_MODEL,max_tokens:1600,temperature:0,messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]});
beforeAll(async()=>{
 fixture.db=new PGlite();
 await fixture.db.exec(`CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE openings(id uuid PRIMARY KEY);
 CREATE TABLE recognition_runs(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,opening_id uuid,photo_hashes jsonb,status text);
 CREATE TABLE recognition_provider_attempts(id uuid PRIMARY KEY,run_id uuid REFERENCES recognition_runs(id),stage text,provider text,model_id text,outcome text,started_at timestamptz DEFAULT now(),finished_at timestamptz,request_manifest jsonb,latency_ms integer,usage jsonb,cost_usd numeric,cost_status text,raw_output text,cost_basis jsonb);`);
 await fixture.db.exec(readFileSync(new URL('../migrations/20261005170938_recognition_stability_budget.sql',import.meta.url),'utf8'));
 await fixture.db.query('INSERT INTO organizations VALUES($1)',[org]);await fixture.db.query('INSERT INTO users VALUES($1)',[actor]);await fixture.db.query('INSERT INTO openings VALUES($1)',[opening]);
},20000);
beforeEach(async()=>{
 await fixture.db.exec('TRUNCATE recognition_stability_reservations,recognition_stability_runs,recognition_stability_trials,recognition_provider_attempts,recognition_runs');
 await fixture.db.query('INSERT INTO recognition_stability_trials(id,organization_id,user_id,opening_id,photo_sha256) VALUES($1,$2,$3,$4,$5)',[trial,org,actor,opening,hash]);
 process.env.OI_STABILITY_TRIAL_REQUIRED='true';process.env.OI_STABILITY_TRIAL_ID=trial;process.env.OI_STABILITY_LOCAL_TEST='true';
});
afterEach(()=>{for(const k of ['OI_STABILITY_TRIAL_REQUIRED','OI_STABILITY_TRIAL_ID','OI_STABILITY_LOCAL_TEST','CONTEXT'])delete process.env[k];vi.unstubAllGlobals();});
afterAll(async()=>fixture.db?.close());
async function run(overrides:any={}){const id=randomUUID();await fixture.db.query('INSERT INTO recognition_runs VALUES($1,$2,$3,$4,$5,$6)',[id,overrides.organization_id||org,overrides.user_id||actor,overrides.opening_id||opening,JSON.stringify(overrides.photo_hashes||[hash]),'running']);return id;}
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
it('records budget before fetch and settles explicit provider usage',async()=>{const id=await registered();const fetch=vi.fn(async()=>{expect(await used()).toBe(624000);return Response.json({content:[{type:'text',text:'{}'}],usage:{input_tokens:10,output_tokens:10}});});vi.stubGlobal('fetch',fetch);await recognitionAudit.run({runId:id,deadline:Date.now()+10000},()=>auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'fixture'));expect(fetch).toHaveBeenCalledTimes(1);expect(await used()).toBe(180);});
it('does not send when remaining budget cannot cover the maximum request',async()=>{const id=await registered(),a=await attempt(id);await reserveStabilityAttempt(a,id,1900000);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(recognitionAudit.run({runId:id,deadline:Date.now()+10000},()=>auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'fixture'))).rejects.toThrow('exhausted');expect(fetch).not.toHaveBeenCalled();});
it('retains the ceiling and pauses after an interrupted send',async()=>{const id=await registered();const fetch=vi.fn(async()=>{throw new TypeError('response lost');});vi.stubGlobal('fetch',fetch);await expect(recognitionAudit.run({runId:id,deadline:Date.now()+10000},()=>auditedFetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify(body())},'fixture'))).rejects.toThrow('response lost');expect(await used()).toBe(624000);await expect(registered()).rejects.toThrow('unavailable');});
