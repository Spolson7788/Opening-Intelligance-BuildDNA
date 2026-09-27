import {it,expect,vi,afterEach} from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn()}}));
import {pool} from '../src/db/pool';
import {authRouter} from '../src/routes/auth';
const app=express();app.use(express.json());app.use('/auth',authRouter);
afterEach(()=>vi.restoreAllMocks());
const input={email:'synthetic@example.invalid',password:'test-only-password'};
it('keeps unknown-account and wrong-password responses indistinguishable except reference',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[]} as never);
 const a=await request(app).post('/auth/login').send(input);
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{password_hash:await bcrypt.hash('different-test-password',4)}]} as never);
 const b=await request(app).post('/auth/login').send(input);
 expect(a.status).toBe(401);expect(b.status).toBe(401);
 expect(a.body.error).toBe(b.body.error);expect(a.body.reference).toMatch(/^[a-f0-9-]{36}$/);
 expect(a.headers['cache-control']).toBe('no-store');
 expect(JSON.stringify(log.mock.calls)).not.toContain(input.email);
 expect(JSON.stringify(log.mock.calls)).not.toContain(input.password);
});
it('reports a database outage as unavailable without leaking exception text',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 vi.mocked(pool.query).mockRejectedValueOnce(new Error('secret-connection-details'));
 const r=await request(app).post('/auth/login').send(input);
 expect(r.status).toBe(503);expect(r.body.error).toBe('authentication_service_unavailable');
 expect(JSON.stringify(log.mock.calls)).not.toContain('secret-connection-details');
});
it('accepts valid credentials and logs no token or password hash',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 const hash=await bcrypt.hash(input.password,4);
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{id:'u',organization_id:'o',role:'technician',is_active:true,password_hash:hash}]} as never);
 const r=await request(app).post('/auth/login').send(input);
 expect(r.status).toBe(200);expect(r.body.token).toBeTruthy();
 expect(JSON.stringify(log.mock.calls)).not.toContain(r.body.token);expect(JSON.stringify(log.mock.calls)).not.toContain(hash);
});
