import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db/pool', () => ({ pool: { query: mocks.query, connect: vi.fn() } }));
import { createPublicQrRouter } from '../src/routes/publicQr';
import { openingsRouter } from '../src/routes/openings';

const token = '11111111-1111-4111-8111-111111111111';
const names = {facility_name:'Synthetic Facility',building_name:'Synthetic Building',opening_code:'SYN-A-PAIR-002'};
const app = (options = {}) => express().use('/api/qr', createPublicQrRouter(options));
beforeEach(() => { mocks.query.mockReset(); });
it.each([false,true])('returns exactly the public allowlist with authenticated=%s',async authenticated=>{
  mocks.query.mockResolvedValue({rows:[{...names,id:'private',organization_id:'private-org',photos:[{url:'private-url'}],budget:123,qr_token:token}]});
  const call=request(app()).get('/api/qr/'+token);
  if(authenticated)call.set('Authorization','Bearer synthetic-ignored').set('Cookie','synthetic=ignored');
  const res=await call;expect(res.status).toBe(200);expect(res.body).toEqual(names);
  expect(res.headers['cache-control']).toBe('no-store');expect(res.headers.vary).toContain('Authorization');
  expect(mocks.query.mock.calls[0][1]).toEqual([token]);
  expect(mocks.query.mock.calls[0][0]).toContain("o.completion_state='complete'");
  expect(mocks.query.mock.calls[0][0]).toContain("o.status NOT IN ('retired','decommissioned')");
});
it('does not return 304 or reuse a previous representation across callers',async()=>{
  mocks.query.mockResolvedValue({rows:[names]});const server=app();
  const first=await request(server).get('/api/qr/'+token);
  const second=await request(server).get('/api/qr/'+token).set('If-None-Match',first.headers.etag).set('Cache-Control','no-cache');
  expect(second.status).toBe(200);expect(second.body).toEqual(names);expect(mocks.query).toHaveBeenCalledTimes(2);
});
it.each(['not-a-token','11111111-1111-4111-8111-111111111111%2Fextra'])('rejects invalid identity %s without querying',async value=>{
  const res=await request(app()).get('/api/qr/'+value);expect(res.status).toBe(404);expect(res.body).toEqual({error:'not_found'});expect(mocks.query).not.toHaveBeenCalled();
});
it('makes unknown and excluded identities unavailable without exposing state',async()=>{
  mocks.query.mockResolvedValue({rows:[]});const res=await request(app()).get('/api/qr/'+token);
  expect(res.status).toBe(404);expect(res.body).toEqual({error:'not_found'});
});
it.each([null,42,undefined])('fails closed for malformed public columns %s',async name=>{
  mocks.query.mockResolvedValue({rows:[{...names,facility_name:name}]});
  const res=await request(app()).get('/api/qr/'+token);expect(res.status).toBe(503);expect(res.body).toEqual({error:'temporarily_unavailable'});
});
it('sanitizes database failure without retrying the query',async()=>{
  mocks.query.mockRejectedValue(new Error('sensitive-database-detail'));
  const res=await request(app()).get('/api/qr/'+token);expect(res.status).toBe(503);expect(JSON.stringify(res.body)).not.toContain('sensitive');expect(mocks.query).toHaveBeenCalledTimes(1);
});
it('bounds repeated and concurrent calls in constant space and resets after a minute',async()=>{
  let time=0;mocks.query.mockResolvedValue({rows:[names]});const server=app({now:()=>time,limit:2});
  const responses=await Promise.all(Array.from({length:4},()=>request(server).get('/api/qr/'+token)));
  expect(responses.filter(r=>r.status===200)).toHaveLength(2);expect(responses.filter(r=>r.status===429)).toHaveLength(2);expect(mocks.query).toHaveBeenCalledTimes(2);
  time=60000;expect((await request(server).get('/api/qr/'+token)).status).toBe(200);
});
it('public knowledge does not authorize protected opening reads for anonymous or foreign tenants',async()=>{
  const server=express().use('/api/qr',createPublicQrRouter()).use('/api/openings',openingsRouter);
  mocks.query.mockImplementation(async(sql:string,values:any[])=>{
    if(sql.includes('p.name AS facility_name'))return {rows:[names]};
    if(sql.includes('FROM users'))return {rows:[{id:'user-b',organization_id:'org-b',role:'admin',is_active:true,session_version:0}]};
    if(sql.includes('qr_token = $1')){expect(values).toEqual([token,'org-b']);return {rows:[]};}
    throw new Error('Unexpected query');
  });
  expect((await request(server).get('/api/qr/'+token)).status).toBe(200);
  expect((await request(server).get('/api/openings/by-qr/'+token)).status).toBe(401);
  const bearer=jwt.sign({userId:'user-b',organizationId:'org-b',role:'admin',sessionVersion:0},process.env.JWT_SECRET!);
  const denied=await request(server).get('/api/openings/by-qr/'+token).set('Authorization','Bearer '+bearer);
  expect(denied.status).toBe(404);expect(denied.body).toEqual({error:'not_found'});
});
it('executes the exact public projection against local PostgreSQL semantics and excludes drafts/retired rows',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE properties(id uuid PRIMARY KEY,name text);
      CREATE TABLE buildings(id uuid PRIMARY KEY,property_id uuid,name text);
      CREATE TABLE openings(qr_token uuid,building_id uuid,opening_code text,completion_state text,status text,private_note text);
      INSERT INTO properties VALUES('${token}','Facility');
      INSERT INTO buildings VALUES('${token}','${token}','Building');
      INSERT INTO openings VALUES('${token}','${token}','OPENING','complete','active','never-public');`);
    const server=app({query:(sql:string,values:string[])=>db.query(sql,values)});
    expect((await request(server).get('/api/qr/'+token)).body).toEqual({facility_name:'Facility',building_name:'Building',opening_code:'OPENING'});
    for(const status of ['retired','decommissioned']){
      await db.query('UPDATE openings SET status=$1',[status]);expect((await request(server).get('/api/qr/'+token)).status).toBe(404);
    }
    await db.exec("UPDATE openings SET status='active',completion_state='draft'");
    expect((await request(server).get('/api/qr/'+token)).status).toBe(404);
  } finally {await db.close();}
});
