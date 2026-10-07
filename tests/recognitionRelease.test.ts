vi.mock('../src/services/labelReading',async(importOriginal)=>({...await importOriginal<typeof import('../src/services/labelReading')>(),readLabels:vi.fn().mockResolvedValue({version:'fixture',status:'no_regions',reads:[],limiting_factor:null})}));
import {beforeEach,describe,it,expect,vi} from 'vitest';
import express from 'express';
import sharp from 'sharp';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks=vi.hoisted(()=>({query:vi.fn(),engine:vi.fn(),connect:vi.fn()}));
vi.mock('../src/db/pool',()=>({pool:{query:mocks.query,connect:mocks.connect}}));
vi.mock('../src/services/legacyVision',()=>({legacyVisionHandler:mocks.engine}));
import {readLabels} from '../src/services/labelReading';
import {recognitionRouter} from '../src/routes/recognition';
const app=express();app.use(express.json({limit:'10mb'}));app.use('/recognition',recognitionRouter);
const body={opening_id:'11111111-1111-4111-8111-111111111111',images:[Buffer.from([255,216,255,0]).toString('base64')],media_type:'image/jpeg'};
const token=()=>jwt.sign({userId:'user',organizationId:'org',sessionVersion:0},process.env.JWT_SECRET!);
const post=(b=body)=>request(app).post('/recognition').set('Authorization',`Bearer ${token()}`).send(b);
beforeEach(async()=>{
 body.images=[(await sharp({create:{width:32,height:20,channels:3,background:'white'}}).jpeg().toBuffer()).toString('base64')];
 process.env.OI_RECOGNITION_SHADOW_ENABLED='true';
 vi.resetAllMocks();vi.mocked(readLabels).mockResolvedValue({version:'fixture',status:'no_regions',reads:[],limiting_factor:null});process.env.OI_RECOGNITION_ENABLED='true';process.env.ANTHROPIC_API_KEY='test-not-real';
 mocks.query.mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValue({rows:[{allowed:1}]});
 mocks.connect.mockResolvedValue({query:mocks.query,release:vi.fn()});
 mocks.engine.mockResolvedValue({statusCode:200,body:JSON.stringify({component_class:null,manufacturer:'Example',model:null})});
});
describe('recognition release boundary',()=>{
 it('blocks an older trial client before preparing originals, registering a run or invoking a provider',async()=>{
  const keys=['OI_STABILITY_TRIAL_REQUIRED','OI_STABILITY_LOCAL_TEST','OI_STABILITY_TRIAL_ID'];const previous=keys.map(k=>process.env[k]);
  try{process.env.OI_STABILITY_TRIAL_REQUIRED='true';process.env.OI_STABILITY_LOCAL_TEST='true';process.env.OI_STABILITY_TRIAL_ID='11111111-1111-4111-8111-111111111111';
   const r=await post();expect(r.status).toBe(409);expect(r.body.error).toBe('recognition_client_update_required');expect(mocks.engine).not.toHaveBeenCalled();expect(readLabels).not.toHaveBeenCalled();expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO recognition_runs'))).toBe(false);
  }finally{keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
 });

 it('requires login before any engine call',async()=>{expect((await request(app).post('/recognition').send(body)).status).toBe(401);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects revoked session',async()=>{mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:1}]});expect((await post()).status).toBe(401);expect(mocks.engine).not.toHaveBeenCalled();});
 it('denies viewer and deactivated accounts',async()=>{for(const user of [{role:'viewer',is_active:true},{role:'technician',is_active:false}]){mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',session_version:0,...user}]});expect((await post()).status).toBe(403);}expect(mocks.engine).not.toHaveBeenCalled();});
 it('denies unassigned opening without disclosing it',async()=>{mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValue({rows:[]});expect((await post()).status).toBe(404);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects spoofed image type',async()=>{expect((await post({...body,images:['YWJjZA==']})).status).toBe(400);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects more than five photographs',async()=>{expect((await post({...body,images:Array(6).fill(body.images[0])})).status).toBe(400);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects aggregate image payload over two megabytes',async()=>{const image=Buffer.alloc(1100000);image.set([255,216,255]);expect((await post({...body,images:[image.toString('base64'),image.toString('base64')]})).status).toBe(413);expect(mocks.engine).not.toHaveBeenCalled();});
 it('stays disabled unless explicitly enabled',async()=>{delete process.env.OI_RECOGNITION_ENABLED;const r=await post();expect(r.status).toBe(503);expect(r.body.error).toBe('recognition_disabled');expect(mocks.engine).not.toHaveBeenCalled();});
 it('reports missing provider configuration without exposing credentials',async()=>{delete process.env.ANTHROPIC_API_KEY;const r=await post();expect(r.status).toBe(503);expect(r.body.error).toBe('recognition_provider_not_configured');expect(mocks.engine).not.toHaveBeenCalled();});
 it('restricts presence-only availability to authenticated permitted roles',async()=>{expect((await request(app).get('/recognition/availability')).status).toBe(401);mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',role:'viewer',is_active:true,session_version:0}]});expect((await request(app).get('/recognition/availability').set('Authorization',`Bearer ${token()}`)).status).toBe(403);});
 it('reports availability without invoking the provider or returning its key',async()=>{process.env.OI_REFERENCE_COMPARISON_ENABLED='false';const r=await request(app).get('/recognition/availability').set('Authorization',`Bearer ${token()}`);expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.body).toEqual({build_sha:null,available:true,blocking_reasons:[],reason:null,reference_comparison_enabled:false});expect(r.text).not.toContain('test-not-real');expect(mocks.engine).not.toHaveBeenCalled();});
 it('reports both configuration blockers in one check',async()=>{delete process.env.OI_RECOGNITION_ENABLED;delete process.env.ANTHROPIC_API_KEY;const r=await request(app).get('/recognition/availability').set('Authorization',`Bearer ${token()}`);expect(r.body.available).toBe(false);expect(r.body.blocking_reasons).toEqual(['recognition_disabled','recognition_provider_not_configured']);expect(mocks.engine).not.toHaveBeenCalled();});
 it('distinguishes opening access failure without exposing database details',async()=>{mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockRejectedValue(Error('private database detail'));const r=await post();expect(r.status).toBe(503);expect(r.body.error).toBe('recognition_opening_access_unavailable');expect(r.text).not.toContain('private');});
 it('distinguishes recording failure without exposing database details',async()=>{mocks.connect.mockRejectedValue(Error('private database connection detail'));const r=await post();expect(r.status).toBe(503);expect(r.body.error).toBe('recognition_recording_unavailable');expect(r.text).not.toContain('private');});
 it('preserves suggestion as unapproved and scoped',async()=>{const r=await post();expect(r.status).toBe(200);expect(r.body.suggestion).toMatchObject({manufacturer:null,model:null,label_reading:{version:'fixture',status:'no_regions'}});expect(r.body.requires_technician_review).toBe(true);expect(r.body.status).toBe('no_reference_evidence');expect(mocks.query.mock.calls[1][1]).toEqual([body.opening_id,'org']);expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO recognition_runs'))).toBe(true);expect(mocks.query.mock.calls.every(([sql])=>!sql.includes('INSERT INTO component_purchasing_approvals'))).toBe(true);});
 it('does not expose provider errors',async()=>{mocks.engine.mockResolvedValue({statusCode:500,body:'sensitive provider detail'});const r=await post();expect(r.status).toBe(502);expect(r.text).not.toContain('sensitive');});
 it('returns only an allowlisted provider failure category',async()=>{mocks.engine.mockResolvedValue({statusCode:502,body:JSON.stringify({error:'recognition_provider_authentication_failed',upstream_message:'private provider detail'})});const r=await post();expect(r.status).toBe(502);expect(r.body).toEqual({error:'recognition_provider_authentication_failed'});expect(r.text).not.toContain('private');});
 it('does not forward arbitrary provider error codes or malformed bodies',async()=>{for(const body of ['private invalid JSON',JSON.stringify({error:'private provider detail'})]){mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValue({rows:[{allowed:1}]});mocks.engine.mockResolvedValue({statusCode:502,body});const r=await post();expect(r.body).toEqual({error:'recognition_provider_failed'});}});
});

it('returns the photo analysis when label processing stalls instead of waiting for the hosting timeout',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 try{
  vi.mocked(readLabels).mockImplementationOnce(()=>new Promise(()=>{}));
  const pending=post().then(r=>r);
  await vi.waitFor(()=>expect(mocks.engine).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(24000);
  const response=await pending;
  expect(response.status).toBe(200);
  expect(response.body.suggestion.manufacturer).toBeNull();
   expect(response.body.suggestion.photograph_identity.manufacturer).toBe('Example');
  expect(response.body.suggestion.label_reading.limiting_factor).toBe('label_processing_timeout');
 }finally{vi.useRealTimers();}
});

it('recovers only the current actor’s exact request on a currently authorized opening',async()=>{
 const requestId='22222222-2222-4222-8222-222222222222';
 mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValueOnce({rows:[{allowed:1}]}).mockResolvedValueOnce({rows:[{id:'run',suggestion:{model:null},stage_one:{label_reading:{candidates:[]}},status:'reference_comparison_unavailable'}]});
 const response=await request(app).get(`/recognition/request/${requestId}?opening_id=${body.opening_id}`).set('Authorization',`Bearer ${token()}`);
 expect(response.status).toBe(200);expect(response.body.request_id).toBe(requestId);
 expect(mocks.query.mock.calls[2][1]).toEqual(['org','user',body.opening_id,requestId]);expect(mocks.engine).not.toHaveBeenCalled();
});
it('does not expose another actor’s run when no exact request match is found',async()=>{
 mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValueOnce({rows:[{allowed:1}]}).mockResolvedValueOnce({rows:[]});
 const response=await request(app).get(`/recognition/request/22222222-2222-4222-8222-222222222222?opening_id=${body.opening_id}`).set('Authorization',`Bearer ${token()}`);
 expect(response.status).toBe(202);expect(response.body).toEqual({status:'awaiting_saved_result'});expect(mocks.engine).not.toHaveBeenCalled();
});


it('waits through a persisted running placeholder and returns the later committed result without paid work',async()=>{
 const requestId='22222222-2222-4222-8222-222222222222';
 const url=`/recognition/request/${requestId}?opening_id=${body.opening_id}`;
 for(const [row,status] of [
  [{id:'run',status:'running',suggestion:{},stage_one:{}},202],
  [{id:'run',status:'reference_evidence',suggestion:{component_class:'DOOR_CLOSER'},stage_one:{label_reading:{candidates:[{model:'4040XP'}]}}},200]
 ] as const){
  mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValueOnce({rows:[{allowed:1}]}).mockResolvedValueOnce({rows:[row]});
  const response=await request(app).get(url).set('Authorization',`Bearer ${token()}`);
  expect(response.status).toBe(status);
  if(status===202)expect(response.body).toEqual({status:'awaiting_saved_result'});
  else {expect(response.body.suggestion.component_class).toBe('DOOR_CLOSER');expect(response.body.label_candidate.model).toBe('4040XP');}
 }
 expect(mocks.engine).not.toHaveBeenCalled();expect(readLabels).not.toHaveBeenCalled();
});
it('rejects failed and empty terminal recovery records',async()=>{
 for(const status of ['failed','reference_evidence']){
  mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValueOnce({rows:[{allowed:1}]}).mockResolvedValueOnce({rows:[{id:'run',status,suggestion:{},stage_one:{}}]});
  const response=await request(app).get(`/recognition/request/22222222-2222-4222-8222-222222222222?opening_id=${body.opening_id}`).set('Authorization',`Bearer ${token()}`);
  expect(response.status).toBe(502);expect(response.body.suggestion).toBeUndefined();
 }
 expect(mocks.engine).not.toHaveBeenCalled();
});
