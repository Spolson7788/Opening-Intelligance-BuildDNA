import {it,expect,vi,beforeEach} from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
const f=vi.hoisted(()=>({query:vi.fn(),register:vi.fn(),claim:vi.fn(),originals:vi.fn(),read:vi.fn(),engine:vi.fn()}));
vi.mock('../src/db/pool',()=>({pool:{query:f.query,connect:async()=>({query:f.query,release:()=>{}})}}));
vi.mock('../src/generated/recognitionBuild.json',()=>({default:{build_sha:'a'.repeat(40)}}));
vi.mock('../src/services/recognitionStabilityBudget',async load=>({...await load<any>(),registerStabilityRun:f.register}));
vi.mock('../src/services/recognitionStages',async load=>({...await load<any>(),claimReaderStage:f.claim}));
vi.mock('../src/services/recognitionOriginals',async load=>({...await load<any>(),prepareRecognitionOriginals:f.originals}));
vi.mock('../src/services/labelReading',async load=>({...await load<any>(),readTargetedLabels:f.read}));
vi.mock('../src/services/legacyVision',()=>({legacyVisionHandler:f.engine}));
import {recognitionRouter} from '../src/routes/recognition';
const app=express();app.use(express.json());app.use('/recognition',recognitionRouter);
const opening='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333';
const regions=[{photo_index:1,x:.1,y:.1,w:.5,h:.5,rotation:0,kind:'brand_mark'},{photo_index:2,x:.1,y:.1,w:.5,h:.5,rotation:0,kind:'product_label'}];
const body={opening_id:opening,request_id:requestId,client_build_sha:'a'.repeat(40),staged:true,photo_ids:[opening,id,requestId],media_type:'image/jpeg',technician_attributes:{component_type:'exit_device',component_type_source:'technician'}};
const post=(b:any)=>request(app).post('/recognition').set('Authorization',`Bearer ${jwt.sign({userId:'user',organizationId:'org',sessionVersion:0},process.env.JWT_SECRET!)}`).send(b);
beforeEach(async()=>{
 vi.clearAllMocks();Object.assign(process.env,{OI_STABILITY_TRIAL_REQUIRED:'true',OI_STABILITY_LOCAL_TEST:'true',OI_STABILITY_TRIAL_ID:opening,OI_RECOGNITION_ENABLED:'true',OI_RECOGNITION_SHADOW_ENABLED:'true',ANTHROPIC_API_KEY:'fixture-not-real'});
 f.query.mockImplementation(async(sql:string)=>({rows:sql.includes('is_active')?[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]:sql.includes('INSERT INTO recognition_runs')||sql.includes('RETURNING id')?[{id}]:sql.startsWith('SELECT 1')?[{allowed:1}]:[]}));
 const image=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer();
 f.originals.mockResolvedValue({images:[image,image,image],sources:[],hashes:['hash','hash2','hash3']});
 f.claim.mockResolvedValue({id,regions,token:'token',mode:'read',hashes:['hash','hash2','hash3']});
 f.read.mockImplementation(async(_images,_type,_deadline,_attributes,stage)=>stage.mode==='locate'?{version:'oi-targeted-label-reading-3',status:'completed',reads:[],planned_regions:regions,stage_outcomes:{label_locator:{status:'succeeded'}},limiting_factor:null}:{version:'oi-targeted-label-reading-3',status:'completed',reads:regions.map((region,i)=>({region,vision_text:i?'Model 6200R':'PDQ',vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed',provenance:{source:'native_tile',target_device:true,location_validated:true}})),stage_outcomes:{label_locator:{status:'succeeded'},label_reader:{status:'succeeded'}},limiting_factor:null});
});
it('persists locator completion, resumes the same run, and fuses grouped identity without a classifier call',async()=>{
 const first=await post(body);expect(first.status).toBe(202);expect(first.body).toMatchObject({run_id:id,request_id:requestId,status:'stage_ready',next_stage:'read'});
 expect(f.register).toHaveBeenCalledTimes(1);expect(f.engine).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.includes("status='failed'"))).toBe(false);
 const second=await post({...body,resume_run_id:id});expect(second.status).toBe(200);expect(second.body.suggestion).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R',component_class:'EXIT_DEVICE'});
 expect(f.register).toHaveBeenCalledTimes(1);expect(f.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO recognition_runs'))).toHaveLength(1);expect(f.engine).not.toHaveBeenCalled();expect(f.read.mock.calls.map(c=>c[4].mode)).toEqual(['locate','read']);
});
it('a duplicate resume refusal cannot mark the other request’s active run failed',async()=>{
 f.claim.mockRejectedValue(Error('recognition_stage_not_resumable'));
 const response=await post({...body,resume_run_id:id});expect(response.status).toBe(409);expect(f.read).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.includes("status='failed'"))).toBe(false);
});
it('changed original hashes stop a claimed reader stage before any reader call',async()=>{
 f.claim.mockResolvedValue({id,regions,token:'token',hashes:['different']});
 const response=await post({...body,resume_run_id:id});expect(response.status).toBe(409);expect(response.body.error).toBe('recognition_stage_input_changed');expect(f.read).not.toHaveBeenCalled();
});

it('checkpoints the first reads and claims a separate focused stage under the same run',async()=>{
 const prior={version:'oi-targeted-label-reading-3',status:'completed',reads:regions.map((region,i)=>({region,vision_text:i?'Model 6200R':'DORMA',vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed',provenance:{source:'native_tile',target_device:true,location_validated:false,box:{x:.3,y:.3,w:.1,h:.1}}})),limiting_factor:null};
 await post(body);
 f.read.mockResolvedValueOnce(prior);
 const second=await post({...body,resume_run_id:id});expect(second.status).toBe(202);expect(second.body.next_stage).toBe('focus');
 expect(f.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO recognition_runs'))).toHaveLength(1);expect(f.register).toHaveBeenCalledTimes(1);
 f.claim.mockResolvedValueOnce({id,regions,token:'focused-token',mode:'focus',labels:prior,hashes:['hash','hash2','hash3']});
 const third=await post({...body,resume_run_id:id});expect(third.status).toBe(200);expect(f.read.mock.calls.at(-1)[4]).toMatchObject({mode:'focus',prior});expect(f.engine).not.toHaveBeenCalled();
});
