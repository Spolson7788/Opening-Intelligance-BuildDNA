import {it,expect,vi,beforeAll,afterAll} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {createHash,randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import request from 'supertest';
const state=vi.hoisted(()=>({db:null as any}));
vi.mock('../src/db/pool',()=>({pool:{connect:async()=>({query:(sql:string,args?:unknown[])=>state.db.query(sql,args),release:()=>{}})}}));
import {accountRecoveryRouter} from '../src/routes/accountRecovery';
const app=express();app.use(express.json());app.use('/recovery',accountRecoveryRouter);
const id='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const email='recovery-test@example.invalid';
beforeAll(async()=>{
 state.db=new PGlite();await state.db.exec(`CREATE TABLE users(id uuid primary key,email text,is_active bool,password_hash text,session_version int default 0,role text,organization_id uuid);
 CREATE TABLE account_recovery_tokens(token_hash text primary key,user_id uuid references users(id),expires_at timestamptz,consumed_at timestamptz);`);
 await state.db.query("INSERT INTO users(id,email,is_active,password_hash,role,organization_id) VALUES ($1,$2,true,'initial','technician',$3)",[id,email,other]);
 process.env.SITE_ID='6430c57d-8a98-43bc-ba25-94007dd244f2';process.env.CONTEXT='deploy-preview';
});
afterAll(async()=>{await state.db.close();delete process.env.SITE_ID;delete process.env.CONTEXT;});
async function code(expired=false){const code=randomBytes(32).toString('hex');await state.db.query("INSERT INTO account_recovery_tokens(token_hash,user_id,expires_at) VALUES ($1,$2,now()+$3::interval)",[createHash('sha256').update(code).digest('hex'),id,expired?'-1 minute':'30 minutes']);return code;}
it('rejects unknown, expired and wrong-account codes without changing credentials',async()=>{
 for(const payload of [{code:'a'.repeat(64),email},{code:await code(true),email},{code:await code(),email:'other@example.invalid'}]){
  expect((await request(app).post('/recovery/confirm').send({...payload,password:'new-synthetic-password'})).status).toBe(400);
 }
 expect((await state.db.query('SELECT session_version FROM users WHERE id=$1',[id])).rows[0].session_version).toBe(0);
});
it('saves a user-chosen password, preserves authority, consumes sibling codes and rejects replay',async()=>{
 const first=await code(),second=await code();const password='local-test-only-password';
 expect((await request(app).post('/recovery/confirm').send({code:first,email,password})).status).toBe(200);
 const user=(await state.db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];
 expect(await bcrypt.compare(password,user.password_hash)).toBe(true);
 expect(user).toMatchObject({session_version:1,role:'technician',organization_id:other,is_active:true});
 for(const value of [first,second])expect((await request(app).post('/recovery/confirm').send({code:value,email,password:'another-test-password'})).status).toBe(400);
});
it('rejects inactive users and overlong bcrypt inputs',async()=>{
 const value=await code();await state.db.query('UPDATE users SET is_active=false WHERE id=$1',[id]);
 expect((await request(app).post('/recovery/confirm').send({code:value,email,password:'long-enough-test-password'})).status).toBe(400);
 expect((await request(app).post('/recovery/confirm').send({code:value,email,password:'密'.repeat(30)})).status).toBe(400);
});
it('enables recovery only for the trusted staging preview context',async()=>{
 const {recoveryDeploymentAllowed}=await import('../src/services/recoveryDeployment');
 const site={id:'6430c57d-8a98-43bc-ba25-94007dd244f2'};
 expect(recoveryDeploymentAllowed({site,deploy:{context:'deploy-preview'}})).toBe(true);
 expect(recoveryDeploymentAllowed({site,deploy:{context:'production'}})).toBe(false);
 expect(recoveryDeploymentAllowed({site:{id:'another-site'},deploy:{context:'deploy-preview'}})).toBe(false);
 expect(recoveryDeploymentAllowed()).toBe(false);
});
