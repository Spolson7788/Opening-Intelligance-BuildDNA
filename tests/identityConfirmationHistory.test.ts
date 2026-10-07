import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
it('appends shadow confirmations, supersedes corrections, preserves run links and queues misses',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE recognition_runs(id uuid PRIMARY KEY,organization_id uuid,opening_id uuid,user_id uuid,suggestion jsonb,stage_one jsonb);CREATE TABLE hardware_components(id uuid PRIMARY KEY,opening_id uuid,manufacturer text,model_number text,identity_status text,identity_acknowledged_by uuid,identity_acknowledged_at timestamptz,identity_recognition_run_id uuid);`);
 await db.exec(readFileSync(new URL('../migrations/20261007185757_identity_confirmation_history.sql',import.meta.url),'utf8'));
 const org=randomUUID(),actor=randomUUID(),opening=randomUUID(),run=randomUUID(),component=randomUUID();
 await db.query('INSERT INTO organizations VALUES($1)',[org]);await db.query('INSERT INTO users VALUES($1)',[actor]);
 await db.query('INSERT INTO recognition_runs VALUES($1,$2,$3,$4,$5,$6)',[run,org,opening,actor,JSON.stringify({manufacturer:null,series:null,model:null}),JSON.stringify({shadow_mode:true,catalog_identity_review:{candidates:[{manufacturer:'PDQ',series:'6200',model:'6200R'}]}})]);
 await db.query("INSERT INTO hardware_components VALUES($1,$2,'PDQ','6200R','established',$3,'2026-10-07T19:00:00Z',$4)",[component,opening,actor,run]);
 await db.query("UPDATE hardware_components SET model_number='6201R',identity_acknowledged_at='2026-10-07T19:01:00Z' WHERE id=$1",[component]);
 await db.query("UPDATE hardware_components SET model_number='6200R',identity_acknowledged_at='2026-10-07T19:02:00Z' WHERE id=$1",[component]);
 const rows=(await db.query<any>('SELECT * FROM identity_confirmations ORDER BY acknowledged_at')).rows;
 expect(rows).toHaveLength(3);expect(rows[1].supersedes_id).toBe(rows[0].id);expect(rows[2].supersedes_id).toBe(rows[1].id);
 expect(rows.every(r=>r.run_id===run&&r.provenance==='ai_seen_corrected')).toBe(true);
 expect(rows[0].series).toBe('6200');expect(rows[1].series).toBeNull();
 expect((await db.query('SELECT * FROM recognition_miss_queue')).rows).toHaveLength(8);
 await expect(db.query("UPDATE identity_confirmations SET model='wrong'")).rejects.toThrow('append_only');
 await db.query("UPDATE hardware_components SET manufacturer='PDQ' WHERE id=$1",[component]);
 expect((await db.query('SELECT * FROM identity_confirmations')).rows).toHaveLength(3);
 }finally{await db.close();}
},20000);
