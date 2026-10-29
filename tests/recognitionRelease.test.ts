import {beforeEach,describe,it,expect,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks=vi.hoisted(()=>({query:vi.fn(),engine:vi.fn()}));
vi.mock('../src/db/pool',()=>({pool:{query:mocks.query}}));
vi.mock('../src/services/legacyVision',()=>({legacyVisionHandler:mocks.engine}));
import {recognitionRouter} from '../src/routes/recognition';
const app=express();app.use(express.json({limit:'10mb'}));app.use('/recognition',recognitionRouter);
const body={opening_id:'11111111-1111-4111-8111-111111111111',images:[Buffer.from([255,216,255,0]).toString('base64')],media_type:'image/jpeg'};
const token=()=>jwt.sign({userId:'user',organizationId:'org',sessionVersion:0},process.env.JWT_SECRET!);
const post=(b=body)=>request(app).post('/recognition').set('Authorization',`Bearer ${token()}`).send(b);
beforeEach(()=>{
 vi.resetAllMocks();process.env.OI_RECOGNITION_ENABLED='true';process.env.ANTHROPIC_API_KEY='test-not-real';
 mocks.query.mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValue({rows:[{allowed:1}]});
 mocks.engine.mockResolvedValue({statusCode:200,body:JSON.stringify({manufacturer:'Example',model:null})});
});
describe('recognition release boundary',()=>{
 it('requires login before any engine call',async()=>{expect((await request(app).post('/recognition').send(body)).status).toBe(401);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects revoked session',async()=>{mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:1}]});expect((await post()).status).toBe(401);expect(mocks.engine).not.toHaveBeenCalled();});
 it('denies viewer and deactivated accounts',async()=>{for(const user of [{role:'viewer',is_active:true},{role:'technician',is_active:false}]){mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',session_version:0,...user}]});expect((await post()).status).toBe(403);}expect(mocks.engine).not.toHaveBeenCalled();});
 // Retired Oct 29 2026: every former request shape gets 410 with the successor, no DB scope read, no engine call.
 it('the retired route answers 410 gone with the successor route and never calls the engine',async()=>{mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]});const image=Buffer.alloc(1100000);image.set([255,216,255]);for(const b of [body,{...body,images:['YWJjZA==']},{...body,images:Array(6).fill(body.images[0])},{...body,images:[image.toString('base64')]}]){const r=await post(b as any);expect(r.status).toBe(410);expect(r.body).toEqual({error:'recognition_route_retired',use:'/api/recognition/runs'});expect(r.headers['cache-control']).toBe('no-store');}expect(mocks.engine).not.toHaveBeenCalled();});
 it('stays retired even when recognition is enabled or disabled',async()=>{mocks.query.mockReset().mockResolvedValue({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]});delete process.env.OI_RECOGNITION_ENABLED;expect((await post()).status).toBe(410);process.env.OI_RECOGNITION_ENABLED='true';expect((await post()).status).toBe(410);expect(mocks.engine).not.toHaveBeenCalled();});
});
