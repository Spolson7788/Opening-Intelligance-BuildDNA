import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {Client} from 'pg';
import {readFileSync} from 'node:fs';
const c=new Client({host:'127.0.0.1',port:55439,database:'condition_readiness',user:'postgres',password:()=>'',ssl:false,connectionTimeoutMillis:2000,options:'-c statement_timeout=8000'});
const subject='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const bucket='oi-video-workflows-media',name='commercial-documents/v1/11111111-1111-4111-8111-111111111111.pdf';
// These fixture helpers emulate the documented auth/operation contract, NOT the Storage gateway.
// All fixture DDL/policies/grants/rows roll back; existing application grants are inspected only.
beforeAll(async()=>{await c.connect();const identity=(await c.query('select current_database() db,inet_server_port() port')).rows[0];expect(identity).toEqual({db:'condition_readiness',port:55439});
 expect((await c.query("select to_regclass('storage.objects') t")).rows[0].t).toBeNull();
 await c.query('BEGIN');await c.query(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA storage;
 CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.subject',true),'')::uuid $$;
 CREATE FUNCTION storage.allow_only_operation(text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(regexp_replace(current_setting('test.operation',true),'^storage\\.',''),'') = nullif(regexp_replace($1,'^storage\\.',''),''),false) $$;
 CREATE TABLE storage.buckets(id text primary key,public boolean not null);
 CREATE TABLE storage.objects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,bucket_id text REFERENCES storage.buckets(id),name text not null,UNIQUE(bucket_id,name));
 ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY; ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA auth,storage TO authenticated; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth,storage TO authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON storage.buckets,storage.objects TO authenticated;
 GRANT USAGE ON ALL SEQUENCES IN SCHEMA storage TO authenticated;
 INSERT INTO storage.buckets VALUES ('oi-video-workflows-media',false),('other',false),('public',true);
 INSERT INTO storage.objects(bucket_id,name) VALUES ('oi-video-workflows-media','${name}'),('oi-video-workflows-media','photos/a.png'),('other','${name}');`);
 const proposal=readFileSync('docs/engineering/storage-technical-identity-REVIEW-ONLY.sql','utf8').replace(/^BEGIN;\r?$/m,'').replace(/^COMMIT;\r?$/m,'');await c.query(proposal);
});
beforeEach(async()=>{await c.query('SAVEPOINT test_case');});
afterEach(async()=>{await c.query('ROLLBACK TO SAVEPOINT test_case');});
afterAll(async()=>{try{await c.query('ROLLBACK');}finally{await c.end();}});
async function context(op:string,user=subject){await c.query('RESET ROLE');await c.query("select set_config('test.subject',$1,true),set_config('test.operation',$2,true)",[user,op]);await c.query('SET LOCAL ROLE authenticated');}
async function denied(sql:string,args?:unknown[]){await c.query('SAVEPOINT denied_probe');try{await expect(c.query(sql,args)).rejects.toMatchObject({code:'42501'});}finally{await c.query('ROLLBACK TO SAVEPOINT denied_probe');}}
async function broaden(){await c.query('RESET ROLE');await c.query('CREATE POLICY future_broad_objects ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true); CREATE POLICY future_broad_buckets ON storage.buckets FOR ALL TO authenticated USING(true) WITH CHECK(true)');}
it('allows exact private bucket metadata and create/read only for the fixed subject',async()=>{
 await context('storage.bucket.get');expect((await c.query('select id from storage.buckets')).rows).toEqual([{id:bucket}]);
 await context('storage.object.upload');await c.query('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,name.replace('11111111-','22222222-')]);
 await context('object.get_authenticated');expect((await c.query('select name from storage.objects order by name')).rows).toHaveLength(2);
});
it('denies other identity and invalid object paths/buckets without broadening',async()=>{
 await context('object.get_authenticated',other);expect((await c.query('select * from storage.objects')).rowCount).toBe(0);
 await context('object.upload',other);await denied('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,name]);
 await context('object.upload');for(const invalid of ['photos/a.pdf','commercial-documents/v1/a.pdf',name+'.png',name+'/extra',name.replace('/v1/','/v2/'),name.replace('4111','9111'),name.toUpperCase()])await denied('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,invalid]);
 await denied('insert into storage.objects(bucket_id,name) values($1,$2)',['other',name]);
});
it('denies list/sign/public/absent/partial operation contexts even with future broad permissive policies',async()=>{
 await broaden();for(const op of ['object.list','object.list_v2','object.sign','object.sign_many','object.get_signed','object.get_public','object','', 's3.object.get']){await context(op);expect((await c.query('select * from storage.objects')).rowCount).toBe(0);}
 for(const op of ['bucket.list','bucket.update','', 'object.get_authenticated']){await context(op);expect((await c.query('select * from storage.buckets')).rowCount).toBe(0);}
 await context('bucket.get');expect((await c.query('select * from storage.buckets')).rows).toEqual([{id:bucket,public:false}]);
});
it('restrictive guards deny insert bypass, mutation and deletion despite broad future policies',async()=>{
 await broaden();await context('object.get_authenticated');expect((await c.query('select name,bucket_id from storage.objects')).rows).toEqual([{name,bucket_id:bucket}]);await context('object.upload');await denied('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,'photos/forbidden.png']);await denied('insert into storage.objects(bucket_id,name) values($1,$2)',['other',name.replace('11111111-','44444444-')]);
 for(const op of ['object.upload_update','object.copy','object.move','object.sign_upload_url','object.upload_signed','s3.upload','']){await context(op);await denied('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,name.replace('11111111-','33333333-')]);}
 // Even mislabelled operations cannot gain UPDATE/DELETE via future permissive policies.
 await context('object.get_authenticated');expect((await c.query("update storage.objects set name='changed' returning id")).rowCount).toBe(0);expect((await c.query('delete from storage.objects returning id')).rowCount).toBe(0);
 await context('bucket.get');expect((await c.query('update storage.buckets set public=true returning id')).rowCount).toBe(0);expect((await c.query('delete from storage.buckets returning id')).rowCount).toBe(0);await denied("insert into storage.buckets values('new',false)");
});
it('restrictive subject guards do not restrict other users existing permissive rights',async()=>{
 await broaden();await context('object.list',other);expect((await c.query('select * from storage.objects')).rowCount).toBe(3);
 await c.query("insert into storage.objects(bucket_id,name) values('other','photos/other-user.png')");expect((await c.query("delete from storage.objects where name='photos/other-user.png'")).rowCount).toBe(1);
 await context('bucket.list',other);expect((await c.query('select * from storage.buckets')).rowCount).toBe(3);
});
it('preserves create-only uniqueness and existing application privilege denial',async()=>{
 await context('object.upload');await c.query('SAVEPOINT duplicate');try{await expect(c.query('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,name])).rejects.toMatchObject({code:'23505'});}finally{await c.query('ROLLBACK TO SAVEPOINT duplicate');}
 await context('object.get_authenticated');await denied('select * from public.openings');
 const privileges=(await c.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and (has_table_privilege(current_user,c.oid,'SELECT') or has_table_privilege(current_user,c.oid,'INSERT') or has_table_privilege(current_user,c.oid,'UPDATE') or has_table_privilege(current_user,c.oid,'DELETE'))")).rows;
 expect(privileges).toEqual([]);
 await c.query('RESET ROLE');expect((await c.query('select count(*)::int n from storage.objects')).rows[0].n).toBe(3);
});

