import {expect,it} from 'vitest';
import {Pool} from 'pg';
import {serverlessPoolConfig} from '../src/db/connectionConfig';

it('serializes real transactions, rolls back, times out without replay, and recovers after release',async()=>{
 const limits=serverlessPoolConfig({OI_DATABASE_POOL_PROFILE:'isolated-serverless',DATABASE_URL:'postgres://synthetic@db.boaoedvyvifppuklbwad.supabase.co/postgres'});
 // Target is hard-coded localhost; the synthetic URL above only selects limits.
 const p=new Pool({...limits,host:'127.0.0.1',port:55439,user:'postgres',database:'condition_readiness',password:()=>'',ssl:false,application_name:'oi-pool-local-test',options:'-c statement_timeout=8000'});
 try {
  const a=await p.connect();
  try {
   const identity=(await a.query('SELECT current_database() db,inet_server_addr()::text host,inet_server_port() port')).rows[0];
   expect(identity).toEqual({db:'condition_readiness',host:'127.0.0.1/32',port:55439});
   await a.query('CREATE TEMP TABLE pool_probe (id int)');
   await a.query('BEGIN');await a.query('INSERT INTO pool_probe VALUES (1)');
   let acquired=false;const waiting=p.connect().then(c=>{acquired=true;return c;});
   await new Promise(r=>setTimeout(r,30));expect(acquired).toBe(false);
   await a.query('ROLLBACK');a.release();
   const b=await waiting;
   try {
    expect((await b.query('SELECT count(*)::int n FROM pool_probe')).rows[0].n).toBe(0);
    const timed=p.connect().then(c=>{c.release();throw Error('unexpected checkout');},()=> 'checkout timeout');
    expect(await timed).toBe('checkout timeout');
    await b.query('BEGIN');await b.query('INSERT INTO pool_probe VALUES (2)');await b.query('COMMIT');
    expect((await b.query('SELECT count(*)::int n FROM pool_probe')).rows[0].n).toBe(1);
    await b.query('DROP TABLE pool_probe');
   } finally {b.release();}
   expect((await p.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  } catch(e) {if(p.idleCount===0&&p.waitingCount===0) {try{a.release(true);}catch{}} throw e;}
 } finally {await p.end();}
},15000);
