vi.mock('../src/services/labelReading',async(importOriginal)=>({...await importOriginal<typeof import('../src/services/labelReading')>(),readLabels:vi.fn().mockResolvedValue({version:'fixture',status:'no_regions',reads:[],limiting_factor:null})}));
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import request from 'supertest';
const provider=vi.hoisted(()=>({identify:vi.fn(),compare:vi.fn()}));
vi.mock('../src/services/legacyVision',()=>({legacyVisionHandler:provider.identify}));
vi.mock('../src/services/referenceEvidence',async(importOriginal)=>({...await importOriginal<any>(),compareWithReferences:provider.compare}));
vi.mock('../src/services/storage',()=>({getPresignedPrivatePhotoReadUrl:vi.fn(async()=> 'https://storage.example.test/signed-page')}));
import {readLabels} from '../src/services/labelReading';
import {pool} from '../src/db/pool';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {retrieveReferences,resolvePartialMarkings,validateCitations,componentType,candidates,conservativeSuggestion} from '../src/services/referenceEvidence';
// Full manufacturer inputs remain private. Public CI uses explicitly synthetic
// SQL fixtures; local corpus integration can point to the audited input folder.
const fixtureRoot=resolve(process.env.OI_REFERENCE_TEST_MANIFEST_DIR||'reference-data');
const privateCorpus=existsSync(resolve(fixtureRoot,'reference_manifest.jsonl'));
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const closerText='4040XP and 4041 DA. Synthetic SQL fixture; not manufacturer evidence.';
const conflictText='The 1260 is adjustable for spring sizes 1-5. Adjustable spring size 1-6';
const syntheticDocs=[
 {sha256:digest('synthetic-closer'),path:'LCN/4040XP/fixture_pull_side.pdf',title:'Synthetic closer fixture',page_count:1},
 {sha256:digest('synthetic-conflict'),path:'LCN/1260/LCN_1260_cut_sheet.pdf',title:'Synthetic conflict fixture',page_count:1},
];
const syntheticPages=syntheticDocs.map((d,i)=>({doc_sha256:d.sha256,page_no:1,page_id:`sha256:${d.sha256}#p1`,text:i?conflictText:closerText,text_sha256:digest(i?conflictText:closerText),citable:true}));
const readJsonl=(name:string)=>readFileSync(resolve(fixtureRoot,name),'utf8').trim().split('\n').map(s=>JSON.parse(s));
const documents=privateCorpus?readJsonl('reference_manifest.jsonl'):syntheticDocs;
const allPages=privateCorpus?readJsonl('reference_pages.jsonl'):syntheticPages;
const sourceConflicts=privateCorpus?readJsonl('conflicts.jsonl'):[{doc_sha256:syntheticDocs[1].sha256,field:'spring_size',values:[{value:'1-5',page:1,quote:'The 1260 is adjustable for spring sizes 1-5.'},{value:'1-6',page:1,quote:'Adjustable spring size 1-6'}]}];

let org:any,outsider:any,opening:string,user:string,doc:any,p:any;
const image=Buffer.from([255,216,255,0]).toString('base64');
const analyze=()=>request(app).post('/api/recognition').set('Authorization','Bearer '+org.token).send({opening_id:opening,images:[image],media_type:'image/jpeg',technician_attributes:{mounting:'regular_arm'}});
beforeAll(async()=>{
 org=await signupTestOrg('Reference fixture');outsider=await signupTestOrg('Other company');
 user=(await pool.query('SELECT id FROM users WHERE email=$1',[org.email])).rows[0].id;
 const hierarchy=await createPortfolioHierarchy(org.token);const o=await createTestOpening(org.token,hierarchy.buildingId);opening=o.id;
 doc=documents.find(d=>/4040XP.*pull_side/.test(d.path));expect(doc).toBeTruthy();
 p=allPages.find(p=>p.doc_sha256===doc.sha256&&p.page_no===1);expect(p.citable).toBe(true);
 await pool.query(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status) VALUES($1,'Allegion','LCN',$2,'installation',$3,'reference/original.pdf',$4,'draft')`,[doc.sha256,doc.title,doc.page_count,JSON.stringify(doc)]);
 await pool.query(`INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable,image_key) VALUES($1,1,$2,$3,'text','none',true,'reference/page.png')`,[doc.sha256,p.text,p.text_sha256]);
 for(const model of ['4040XP','4041 DA'])await pool.query('INSERT INTO reference_document_models(doc_sha256,model,evidence_page,evidence_quote) VALUES($1,$2,1,$3)',[doc.sha256,model,p.text]);
 process.env.OI_RECOGNITION_ENABLED='true';process.env.OI_REFERENCE_COMPARISON_ENABLED='true';process.env.ANTHROPIC_API_KEY='test-fixture-never-used';
 provider.identify.mockResolvedValue({statusCode:200,body:JSON.stringify({component_class:'DOOR_CLOSER',manufacturer:'LCN',series:'4040XP',model:'4040XP',visible_text:['4040XP'],attributes:{}})});
 provider.compare.mockResolvedValue({candidates:[],citations:[{page_id:p.page_id,doc_sha256:doc.sha256,page_no:1,quote:'4040XP'}],unresolved:['Check delay-valve evidence before distinguishing 4041 DA.']});
});
afterAll(()=>{delete process.env.OI_RECOGNITION_ENABLED;delete process.env.OI_REFERENCE_COMPARISON_ENABLED;delete process.env.ANTHROPIC_API_KEY;});
describe(privateCorpus?'audited corpus retrieval with recorded provider fixtures':'synthetic SQL/API reference fixtures (no manufacturer acceptance claim)',()=>{
 it('drafts never appear in lookup, search, or page API',async()=>{
  expect(await retrieveReferences({manufacturer:'LCN',model:'4040XP'},{})).toEqual([]);
  expect((await request(app).get(`/api/references/${doc.sha256}/pages/1`).set('Authorization','Bearer '+org.token)).status).toBe(404);
  const r=await analyze();expect(r.status).toBe(200);expect(r.body.status).toBe('no_reference_evidence');expect(r.body.citations).toEqual([]);
 });
 it('org administrators have no approval endpoint and cannot write as the API database role',async()=>{
  expect((await request(app).post(`/api/references/${doc.sha256}/approve`).set('Authorization','Bearer '+org.token)).status).toBe(404);
  const c=await pool.connect();try{await c.query('SET ROLE oi_pr2_api');await expect(c.query("UPDATE reference_documents SET status='draft'")).rejects.toThrow();}finally{await c.query('RESET ROLE');c.release();}
 });
 it('retrieves the configured 4040XP fixture page only after explicit fixture approval, stores hashes and audit atomically',async()=>{
  await pool.query("UPDATE reference_documents SET status='approved',approved_by=$2,approved_at=now() WHERE sha256=$1",[doc.sha256,user]);
  const r=await analyze();expect(r.status).toBe(200);expect(r.body.requires_technician_review).toBe(true);expect(r.body.status).toBe('reference_evidence');expect(r.body.citations[0].page_id).toBe(p.page_id);
  const run=(await pool.query('SELECT * FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0];expect(run.retrieved_pages[0].text_sha256).toBe(p.text_sha256);expect(run.technician_attributes.mounting).toBe('regular_arm');expect(run.component_type).toBe('closer');
  expect((await pool.query("SELECT * FROM audit_log WHERE request_body->>'run_id'=$1",[run.id])).rows).toHaveLength(1);
 });
 it('retrieves candidate family references from label evidence without asserting an exact model',async()=>{
  provider.identify.mockResolvedValueOnce({statusCode:200,body:JSON.stringify({component_class:'DOOR_CLOSER',manufacturer:null,model:null,series:null,visible_text:[],attributes:{}})});
  vi.mocked(readLabels).mockResolvedValueOnce({version:'fixture-label',status:'completed',limiting_factor:null,reads:[{region:{photo_index:0,x:.1,y:.1,w:.3,h:.1,rotation:180},ocr_text:'LCN 4040',ocr_confidence:70,vision_text:'LCN 4040',agreed_markings:['LCN','4040'],status:'agreement'}]});
  const r=await analyze();expect(r.status).toBe(200);expect(r.body.status).toBe('reference_evidence');
  expect(r.body.suggestion).toMatchObject({manufacturer:'LCN',series:'4040',model:null,label_reading:{version:'fixture-label'}});
  const stored=(await pool.query('SELECT stage_one,suggestion FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0];
  expect(stored.stage_one.label_reading.reads[0].region.rotation).toBe(180);expect(stored.suggestion.model).toBeNull();
 });
 it('strips fabricated page ids and invented quotes, including nested feature citations',async()=>{
  const bad={page_id:p.page_id,doc_sha256:doc.sha256,page_no:1,quote:'This sentence is fabricated.'};
  provider.compare.mockResolvedValueOnce({citations:[bad],candidates:[{supporting_features:[{citation:bad}]}],unresolved:[]});
  const r=await analyze();expect(r.body.citations).toEqual([]);expect(r.body.comparison.candidates[0].supporting_features[0].citation).toBeNull();
  expect((await pool.query('SELECT rejected_citations FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0].rejected_citations).toHaveLength(2);
 });
 it('does not borrow a family page for an unsupported specific model',async()=>{
  expect(candidates({model:'4040XP-UNSUPPORTED',series:'4040XP'},{})).toEqual(['4040xp-unsupported']);
  expect(await retrieveReferences({manufacturer:'LCN',model:'4040XP-UNSUPPORTED',series:'4040XP'},{})).toEqual([]);
 });
 it('uses reported CR441 for reference lookup and review while leaving photo identity and purchases unconfirmed',async()=>{
  const hash=digest('synthetic-reported-cr441'),text='CR441 Series. Synthetic SQL fixture; not manufacturer evidence.';
  await pool.query(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,approved_by,approved_at) VALUES($1,'Cal-Royal','Cal-Royal','Synthetic CR441 fixture','product_data',1,'reference/cr441.pdf','{}','approved',$2,now())`,[hash,user]);
  await pool.query(`INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable) VALUES($1,1,$2,$3,'text','none',true)`,[hash,text,digest(text)]);
  await pool.query(`INSERT INTO reference_document_models(doc_sha256,model,evidence_page,evidence_quote) VALUES($1,'CR441',1,'CR441')`,[hash]);
  const before=(await pool.query('SELECT * FROM component_purchasing_approvals ORDER BY component_id')).rows;
  provider.identify.mockResolvedValueOnce({statusCode:200,body:JSON.stringify({component_class:'DOOR_CLOSER',manufacturer:null,model:null,series:null,visible_text:[]})});
  provider.compare.mockResolvedValueOnce({candidates:[],citations:[{page_id:`sha256:${hash}#p1`,doc_sha256:hash,page_no:1,quote:'CR441'}],unresolved:['Confirm technician-reported model.']});
  const r=await request(app).post('/api/recognition').set('Authorization','Bearer '+org.token).send({opening_id:opening,images:[image],media_type:'image/jpeg',technician_attributes:{visible_markings:'CR441',component_type:'lockset',mounting_scope:'opening'}});
  expect(r.status).toBe(200);expect(r.body.status).toBe('reference_evidence');
  expect(r.body.reported_identity).toEqual({manufacturer:'Cal-Royal',model:'CR441'});
  expect(r.body.suggestion.model).toBeNull();expect(r.body.requires_technician_review).toBe(true);
  expect((await pool.query('SELECT retrieved_pages FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0].retrieved_pages[0].doc_sha256).toBe(hash);
  expect((await pool.query('SELECT * FROM component_purchasing_approvals ORDER BY component_id')).rows).toEqual(before);
 });
 it('uses approved catalog matches for a partial dirty-label reading without completing the photographed identity',async()=>{
  const labels:any={version:'partial-fixture',status:'completed',limiting_factor:null,reads:[{region:{photo_index:0,x:0,y:0,w:1,h:1,rotation:0},ocr_text:'Fae',ocr_confidence:20,vision_text:'4040X?',agreed_markings:[],status:'unconfirmed'}]};
  expect(await resolvePartialMarkings(labels)).toMatchObject([{manufacturer:'LCN',model:'4040XP',transcribed_marking:'4040X?'}]);
  expect(await resolvePartialMarkings(labels,'Cal-Royal')).toEqual([]);
  vi.mocked(readLabels).mockResolvedValueOnce(labels);
  provider.identify.mockResolvedValueOnce({statusCode:200,body:JSON.stringify({component_class:'DOOR_CLOSER',manufacturer:null,model:null,series:null,visible_text:[]})});
  const r=await analyze();expect(r.status).toBe(200);
  expect(r.body.label_candidate).toMatchObject({model:'4040XP',transcribed_marking:'4040X?'});
  expect(r.body.suggestion.model).toBeNull();expect(r.body.suggestion.manufacturer).toBeNull();
  expect(r.body.requires_technician_review).toBe(true);
  expect((await pool.query('SELECT retrieved_pages FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0].retrieved_pages).not.toHaveLength(0);
 });
 it('retrieves approved closer candidates for marker estimates without a readable product label',async()=>{
  provider.identify.mockResolvedValueOnce({statusCode:200,body:JSON.stringify({component_class:'DOOR_CLOSER',manufacturer:null,model:null,series:null,visible_text:[],scale_measurements:[{feature:'closer_body_length',estimate_mm:200,basis:'marker_plane_estimate'}]})});
  const r=await analyze();expect(r.status).toBe(200);expect(r.body.suggestion.model).toBeNull();
  expect(r.body.suggestion.reference_lookup_basis).toBe('marker_dimensions_candidate_search');
  expect((await pool.query('SELECT retrieved_pages FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0].retrieved_pages).not.toHaveLength(0);
 });
 it('withdrawn documents disappear on the next lookup and page read',async()=>{
  await pool.query("UPDATE reference_documents SET status='draft' WHERE sha256=$1",[doc.sha256]);
  expect(await retrieveReferences({manufacturer:'LCN',model:'4040XP'},{})).toEqual([]);
  expect((await request(app).get(`/api/references/${doc.sha256}/pages/1`).set('Authorization','Bearer '+org.token)).status).toBe(404);
  await pool.query("UPDATE reference_documents SET status='approved' WHERE sha256=$1",[doc.sha256]);
 });
 it('history is shared through current opening authorization and denies another company',async()=>{
  const a=await request(app).get('/api/recognition/opening/'+opening).set('Authorization','Bearer '+org.token);expect(a.status).toBe(200);expect(a.body.runs.length).toBeGreaterThan(0);
  expect((await request(app).get('/api/recognition/opening/'+opening).set('Authorization','Bearer '+outsider.token)).status).toBe(404);
 });
 it('never creates purchasing approvals and retains pending identity',async()=>{
  const before=(await pool.query('SELECT * FROM component_purchasing_approvals ORDER BY component_id')).rows;
  expect((await analyze()).body.requires_technician_review).toBe(true);
  expect((await pool.query('SELECT * FROM component_purchasing_approvals ORDER BY component_id')).rows).toEqual(before);
  expect(componentType('COORDINATOR')).toBe('other');expect(componentType('HINGE_CONT')).toBe('hinge');
 });
 it('comparison outage still returns stage one and persists a degraded run',async()=>{
  provider.compare.mockRejectedValueOnce(Error('offline'));const r=await analyze();expect(r.status).toBe(200);expect(r.body.status).toBe('reference_comparison_unavailable');expect(r.body.citations).toEqual([]);
 });
 it('rejects cross-document hash and page mismatches even for a retrieved page id',()=>{
  expect(validateCitations([{page_id:p.page_id,doc_sha256:'f'.repeat(64),page_no:1,quote:'4040XP'}],[{...p,brand:'LCN',title:'Test',models:['4040XP']}]).accepted).toEqual([]);
 });
 it('keeps look-alikes unresolved and lowers confidence without photographed distinguishing evidence',()=>{
  for(const model of ['98','99','4040XP','4041 DA']){
   const comparison={unresolved:[]};const r=conservativeSuggestion({model,visible_text:[],evidence:[],confidence:{model:.9}},comparison);
   expect(r.model).toBeNull();expect(r.confidence.model).toBe(.4);expect(comparison.unresolved).toHaveLength(1);
  }
 });
 it('requires a separate switch before making the additional comparison call',async()=>{
  delete process.env.OI_REFERENCE_COMPARISON_ENABLED;const count=provider.compare.mock.calls.length;
  const r=await analyze();expect(r.body.status).toBe('reference_comparison_disabled');expect(provider.compare.mock.calls).toHaveLength(count);
  process.env.OI_REFERENCE_COMPARISON_ENABLED='true';
 });
 it('links evidence during real component synchronization and replays idempotently',async()=>{
  const r=await analyze(),id=crypto.randomUUID();
  const body={operation_id:crypto.randomUUID(),entity_id:id,opening_id:opening,device_id:crypto.randomUUID(),base_server_revision:null,schema_version:1,protocol_version:1,app_version:'reference-test',payload:{component_type:'closer',recognition_run_id:r.body.run_id,identity_status:'unresolved',review_state:'pending'}};
  const send=()=>request(app).post('/api/sync/components').set('Authorization','Bearer '+org.token).send(body);
  expect((await send()).status).toBe(201);expect((await send()).body.status).toBe('already_applied');
  const run=(await pool.query('SELECT component_id FROM recognition_runs WHERE id=$1',[r.body.run_id])).rows[0];expect(run.component_id).toBe(id);
  const h=(await pool.query('SELECT identity_status,review_state FROM hardware_components WHERE id=$1',[id])).rows[0];expect(h).toEqual({identity_status:'unresolved',review_state:'pending'});
 });
 it('refuses component creation with another user/opening recognition record',async()=>{
  const id=crypto.randomUUID();const body={operation_id:crypto.randomUUID(),entity_id:id,opening_id:opening,device_id:crypto.randomUUID(),base_server_revision:null,schema_version:1,protocol_version:1,app_version:'reference-test',payload:{component_type:'closer',recognition_run_id:crypto.randomUUID()}};
  expect((await request(app).post('/api/sync/components').set('Authorization','Bearer '+org.token).send(body)).status).toBe(400);
  expect((await pool.query('SELECT 1 FROM hardware_components WHERE id=$1',[id])).rows).toHaveLength(0);
 });
 it('returns both conflicting 1260 values and leaves the specification unresolved',async()=>{
  const d=documents.find(d=>d.path==='LCN/1260/LCN_1260_cut_sheet.pdf');const page=allPages.find(p=>p.doc_sha256===d.sha256&&p.page_no===1);
  const conflict=sourceConflicts.find(c=>c.doc_sha256===d.sha256);
  await pool.query(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,approved_by,approved_at) VALUES($1,'Allegion','LCN',$2,'product_data',$3,'reference/1260.pdf',$4,'approved',$5,now())`,[d.sha256,d.title,d.page_count,JSON.stringify(d),user]);
  await pool.query(`INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable) VALUES($1,1,$2,$3,'text','none',true)`,[d.sha256,page.text,page.text_sha256]);
  await pool.query('INSERT INTO reference_document_models(doc_sha256,model,evidence_page,evidence_quote) VALUES($1,\'1260\',1,$2)',[d.sha256,page.text]);
  await pool.query('INSERT INTO reference_conflicts(doc_sha256,field,values) VALUES($1,$2,$3)',[d.sha256,conflict.field,JSON.stringify(conflict.values)]);
  provider.identify.mockResolvedValueOnce({statusCode:200,body:JSON.stringify({manufacturer:'LCN',model:'1260',visible_text:['1260']})});
  provider.compare.mockResolvedValueOnce({citations:conflict.values.map((v:any)=>({page_id:page.page_id,doc_sha256:d.sha256,page_no:1,quote:v.quote})),measurements:{spring_size:'1-6'},unresolved:[]});
  const r=await analyze();expect(r.status).toBe(200);expect(r.body.conflicts[0].values.map((v:any)=>v.value)).toEqual(['1-5','1-6']);expect(r.body.comparison.measurements.spring_size).toBeNull();expect(r.body.citations).toHaveLength(2);expect(r.body.comparison.unresolved).toHaveLength(1);
 });
 it('superseded and duplicate references never appear in retrieval',async()=>{
  const target=documents.find(d=>d.path==='LCN/1260/LCN_1260_cut_sheet.pdf').sha256;
  for(const status of ['superseded','duplicate']){
   await pool.query('UPDATE reference_documents SET status=$2,superseded_by=$3,duplicate_of=$3 WHERE sha256=$1',[doc.sha256,status,target]);
   expect(await retrieveReferences({manufacturer:'LCN',model:'4040XP'},{})).toHaveLength(0);
  }
  await pool.query("UPDATE reference_documents SET status='approved',superseded_by=NULL,duplicate_of=NULL WHERE sha256=$1",[doc.sha256]);
 });
 it('page constraints reject citable blank, unverified drawing, and fraction pages',async()=>{
  for(const patch of ["page_class='blank'","page_class='drawing'","fraction_unverified=true"]){
   await expect(pool.query(`UPDATE reference_pages SET ${patch} WHERE doc_sha256=$1`,[doc.sha256])).rejects.toThrow();
  }
 });
 it('importer cannot approve documents, write approval fields, or change approved evidence',async()=>{
  const c=await pool.connect();try{
   await c.query('SET ROLE oi_reference_editor');
   const r=await c.query(`UPDATE reference_documents SET status='approved' WHERE sha256='${doc.sha256}'`);expect(r.rowCount).toBe(0);
   await expect(c.query(`UPDATE reference_documents SET approved_by='${user}' WHERE sha256='${doc.sha256}'`)).rejects.toThrow();
   await expect(c.query(`UPDATE reference_pages SET text='changed' WHERE doc_sha256='${doc.sha256}'`)).rejects.toThrow();
   await expect(c.query(`DELETE FROM reference_documents WHERE sha256='${doc.sha256}'`)).rejects.toThrow();
  }finally{await c.query('RESET ROLE');c.release();}
 });
 it('importer can import a draft but cannot insert it as approved',async()=>{
  const h='a'.repeat(64);const c=await pool.connect();try{
   await c.query('SET ROLE oi_reference_editor');
   const sql=`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,approved_by,approved_at) VALUES('${h}','Allegion','LCN','Import fixture','installation',1,'reference/fixture.pdf','{}',`;
   await expect(c.query(sql+`'approved','${user}',now()) RETURNING sha256`)).rejects.toThrow();
   expect((await c.query(sql+`'draft',NULL,NULL) RETURNING sha256`)).rows).toHaveLength(1);
   await expect(c.query(`UPDATE reference_documents SET status='approved' WHERE sha256='${h}'`)).rejects.toThrow();
  }finally{await c.query('RESET ROLE');c.release();}
 });
 it('dedicated approver can lock authority and atomically approve with an audit record',async()=>{
  await pool.query('INSERT INTO reference_approvers(user_id) VALUES($1)',[user]);
  await pool.query("UPDATE reference_documents SET status='draft' WHERE sha256=$1",[doc.sha256]);
  const c=await pool.connect();try{
   await c.query('BEGIN');await c.query('SET LOCAL ROLE oi_reference_approver');
   const a=await c.query('SELECT u.organization_id FROM reference_approvers a JOIN users u ON u.id=a.user_id WHERE u.id=$1 AND u.is_active FOR SHARE',[user]);expect(a.rows).toHaveLength(1);
   await c.query("UPDATE reference_documents SET status='approved',approved_by=$2,approved_at=now() WHERE sha256=$1",[doc.sha256,user]);
   await c.query("INSERT INTO audit_log(organization_id,user_id,action,method,path,status_code) VALUES($1,$2,'Approved manufacturer reference','CLI','reference/approval',200)",[org.organizationId,user]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.query('RESET ROLE');c.release();}
  expect((await pool.query("SELECT * FROM audit_log WHERE user_id=$1 AND action='Approved manufacturer reference'",[user])).rows).toHaveLength(1);
 });
});
