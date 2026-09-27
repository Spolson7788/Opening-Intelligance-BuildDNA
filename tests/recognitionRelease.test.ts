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
 it('denies unassigned opening without disclosing it',async()=>{mocks.query.mockReset().mockResolvedValueOnce({rows:[{id:'user',organization_id:'org',role:'technician',is_active:true,session_version:0}]}).mockResolvedValue({rows:[]});expect((await post()).status).toBe(404);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects spoofed image type',async()=>{expect((await post({...body,images:['YWJjZA==']})).status).toBe(400);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects more than five photographs',async()=>{expect((await post({...body,images:Array(6).fill(body.images[0])})).status).toBe(400);expect(mocks.engine).not.toHaveBeenCalled();});
 it('rejects aggregate image payload over two megabytes',async()=>{const image=Buffer.alloc(1100000);image.set([255,216,255]);expect((await post({...body,images:[image.toString('base64'),image.toString('base64')]})).status).toBe(413);expect(mocks.engine).not.toHaveBeenCalled();});
 it('stays disabled unless explicitly enabled',async()=>{delete process.env.OI_RECOGNITION_ENABLED;expect((await post()).status).toBe(503);expect(mocks.engine).not.toHaveBeenCalled();});
 it('preserves suggestion as unapproved and scoped',async()=>{const r=await post();expect(r.status).toBe(200);expect(r.body).toEqual({suggestion:{manufacturer:'Example',model:null},requires_technician_review:true});expect(mocks.query.mock.calls[1][1]).toEqual([body.opening_id,'org']);expect(mocks.query.mock.calls.every(([sql])=>sql.trim().startsWith('SELECT'))).toBe(true);});
 it('does not expose provider errors',async()=>{mocks.engine.mockResolvedValue({statusCode:500,body:'sensitive provider detail'});const r=await post();expect(r.status).toBe(502);expect(r.text).not.toContain('sensitive');});
});
