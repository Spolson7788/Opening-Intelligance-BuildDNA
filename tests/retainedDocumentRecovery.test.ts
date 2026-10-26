import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {recoverRetainedDocument,retainedRecoveryActor,retainedRecoveryWindow,RETAINED_DOCUMENT as p} from '../src/services/retainedDocumentRecovery';
let db:PGlite;
const bytes=readFileSync('tests/fixtures/retained-synthetic-document.pdf');
const store=()=>({privateImmutable:true as const,mode:'verified' as const,read:vi.fn(async()=>bytes),putOnce:vi.fn(async()=>{throw Error('must never upload');})});
const ctx={site:{id:p.site},deploy:{context:'production'}};
const env={OI_RETAINED_DOCUMENT_ENABLED:'true',OI_RETAINED_DOCUMENT_START:'2026-10-26T00:00:00Z',OI_RETAINED_DOCUMENT_END:'2026-10-26T00:15:00Z'};
beforeEach(async()=>{db=new PGlite();await db.exec(`CREATE TABLE commercial_documents(id uuid PRIMARY KEY,organization_id uuid,property_id uuid,title text,kind text,head_version integer);
CREATE TABLE commercial_document_versions(id uuid PRIMARY KEY,document_id uuid REFERENCES commercial_documents(id),version integer,object_key text UNIQUE,sha256 text,byte_size integer,content_type text,recorded_by uuid,request_hash text,recorded_at timestamptz DEFAULT now(),verified_at timestamptz DEFAULT now());`);});
afterEach(async()=>{await db.close();});
async function run(s=store(),allowed=()=>true){await db.exec('BEGIN');try{const result=await recoverRetainedDocument(db,s,allowed);await db.exec('COMMIT');return result;}catch(e){await db.exec('ROLLBACK');throw e;}}
it('requires exact site, production, enabled flag and bounded current window',()=>{
 const now=Date.parse('2026-10-26T00:01:00Z');expect(retainedRecoveryWindow(ctx,env,now)).toBe(true);
 for(const c of [undefined,{...ctx,site:{id:'other'}},{...ctx,deploy:{context:'deploy-preview'}}])expect(retainedRecoveryWindow(c,env,now)).toBe(false);
 for(const e of [{...env,OI_RETAINED_DOCUMENT_ENABLED:'false'},{...env,OI_RETAINED_DOCUMENT_END:'2026-10-26T00:16:00Z'},{...env,OI_RETAINED_DOCUMENT_START:'bad'}])expect(retainedRecoveryWindow(ctx,e,now)).toBe(false);
 expect(retainedRecoveryWindow(ctx,env,Date.parse(env.OI_RETAINED_DOCUMENT_END))).toBe(false);
 expect(retainedRecoveryWindow(ctx,env,Date.parse(env.OI_RETAINED_DOCUMENT_START)-1)).toBe(false);
});
it('requires exact current admin and organization',()=>{const a={userId:p.actor,organizationId:p.org,role:'admin'};expect(retainedRecoveryActor(a)).toBe(true);for(const b of [undefined,{...a,userId:'other'},{...a,organizationId:'other'},{...a,role:'facilities_manager'}])expect(retainedRecoveryActor(b)).toBe(false);});
it('reads only exact retained object and atomically records honest new provenance',async()=>{
 const started=Date.now();const s=store();expect(await run(s)).toMatchObject({recovered:true,replayed:false,id:p.version});expect(s.putOnce).not.toHaveBeenCalled();expect(s.read).toHaveBeenCalledExactlyOnceWith(p.version);
 const v=(await db.query<any>('SELECT * FROM commercial_document_versions')).rows[0],d=(await db.query<any>('SELECT * FROM commercial_documents')).rows[0];
 expect(v).toMatchObject({document_id:p.series,object_key:p.version,sha256:p.sha256,byte_size:664,recorded_by:p.actor,version:1});expect(d).toMatchObject({organization_id:p.org,property_id:null,title:p.title,kind:'technical',head_version:1});expect(new Date(v.recorded_at).getTime()).toBeGreaterThan(started-1000);
});
it('reconciles lost-response replay without additional records or uploads',async()=>{await run();const s=store();expect(await run(s)).toMatchObject({replayed:true});expect((await db.query('SELECT * FROM commercial_document_versions')).rows).toHaveLength(1);expect(s.putOnce).not.toHaveBeenCalled();});
it('denies disabled guard before any read or write',async()=>{const s=store();await expect(run(s,()=>false)).rejects.toThrow('unavailable');expect(s.read).not.toHaveBeenCalled();expect((await db.query('SELECT * FROM commercial_documents')).rows).toHaveLength(0);});
it('rolls back if authorization expires before commit',async()=>{let calls=0;await expect(run(store(),()=>++calls<4)).rejects.toThrow('unavailable');expect((await db.query('SELECT * FROM commercial_documents')).rows).toHaveLength(0);expect((await db.query('SELECT * FROM commercial_document_versions')).rows).toHaveLength(0);});
it('rejects missing storage, corrupt bytes and changed length with no metadata',async()=>{for(const b of [Buffer.from('not pdf'),Buffer.alloc(664),Buffer.concat([bytes,Buffer.from('x')])]){const s=store();s.read.mockResolvedValue(b);await expect(run(s)).rejects.toThrow('integrity');}expect((await db.query('SELECT * FROM commercial_documents')).rows).toHaveLength(0);});
it('redacts storage failure and never attempts an upload',async()=>{const s=store();s.read.mockRejectedValue(Error('SECRET PROVIDER CONTENT'));await expect(run(s)).rejects.toThrow('retained_document_read_unavailable');expect(s.putOnce).not.toHaveBeenCalled();});
it('refuses existing metadata with different tenant or provenance',async()=>{await run();await db.query('UPDATE commercial_documents SET organization_id=$1',['00000000-0000-4000-8000-000000000001']);await expect(run()).rejects.toThrow('identity_conflict');});
it('rolls back series insertion if version insertion fails',async()=>{await db.exec("ALTER TABLE commercial_document_versions ADD CONSTRAINT test_failure CHECK(false)");await expect(run()).rejects.toThrow();expect((await db.query('SELECT * FROM commercial_documents')).rows).toHaveLength(0);});
it('refuses a conflicting series without changing it',async()=>{await db.query('INSERT INTO commercial_documents VALUES($1,$2,NULL,$3,$4,0)',[p.series,p.org,'Other title','technical']);await expect(run()).rejects.toThrow('identity_conflict');expect((await db.query('SELECT * FROM commercial_document_versions')).rows).toHaveLength(0);});
