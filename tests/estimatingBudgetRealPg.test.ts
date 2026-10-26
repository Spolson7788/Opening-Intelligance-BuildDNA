import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state=vi.hoisted(()=>({pool:null as any}));
vi.mock('../src/db/pool',()=>{
 async function connect(){const c=await state.pool.connect();try{await c.query('SET ROLE oi_pr2_api');}catch(e){c.release(true);throw e;}return {
  query:(s:string,a?:unknown[])=>c.query(s,a),release:()=>{void c.query('RESET ROLE').then(()=>c.release(),()=>c.release(true));}};}
 return {pool:{connect,query:async(s:string,a?:unknown[])=>{const c=await connect();try{return await c.query(s,a);}finally{c.release();}}}};
});
import {commercialRouter} from '../src/routes/commercial';
import {sandboxFinanceRouter} from '../src/routes/sandboxFinance';
import {planningRouter} from '../src/routes/planning';
import {createFixtureCommercialStore} from '../src/services/commercialStorage';
const options={host:'127.0.0.1',port:55439,database:'condition_readiness',user:'postgres',password:()=>'',ssl:false as const,
 connectionTimeoutMillis:2000,options:'-c statement_timeout=8000',application_name:'oi-estimating-budget-local-tests'};
const admin=new Pool(options),sql=(s:string,a?:any[])=>admin.query(s,a);
const app=express();app.use(express.json());
app.locals.commercialStore=createFixtureCommercialStore();app.locals.commercialInputsOnly=true;app.locals.commercialInputsEnabled=true;
app.locals.facilityBudgetEnabled=true;app.locals.planningSandboxEnabled=false;
app.use('/api/commercial',commercialRouter);app.use('/api/sandbox-finance',sandboxFinanceRouter);app.use('/api/planning',planningRouter);
const inputTables=['commercial_documents','commercial_document_versions','provider_catalog_items','provider_catalog_versions','replacement_estimates','replacement_estimate_versions','commercial_document_links','sandbox_budget_series','sandbox_budget_versions'];
const heads=['commercial_documents','provider_catalog_items','replacement_estimates','sandbox_budget_series'];
const versions=['commercial_document_versions','provider_catalog_versions','replacement_estimate_versions','sandbox_budget_versions'];
const held=['estimate_reviews','sandbox_plans','sandbox_plan_versions','sandbox_plan_events','sandbox_delivery_holds','sandbox_cost_records','sandbox_invoice_identity'];
const proposalHash='37cd4dba551c5ac9cfc925dc03e47924ebe5865ee165a650bc02fe0f38739a48';
beforeAll(async()=>{
 const identity=(await sql('SELECT current_database() db,inet_server_addr()::text address,inet_server_port() port')).rows[0];
 expect({...identity,address:identity.address.replace(/\/32$/,'')}).toEqual({db:'condition_readiness',address:'127.0.0.1',port:55439});
 expect((await sql("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='oi_pr2_api'")).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
 expect((await sql("SELECT to_regclass('public.condition_observations')::text AS name")).rows[0].name).toBe('condition_observations');
 // Fail if this is not the deployed restricted baseline. Never repair or broaden it here.
 for(const table of [...inputTables,...held]){
  const p=(await sql("SELECT has_table_privilege('oi_pr2_api',$1,'SELECT') s,has_table_privilege('oi_pr2_api',$1,'INSERT') i,has_table_privilege('oi_pr2_api',$1,'UPDATE') u,has_table_privilege('oi_pr2_api',$1,'DELETE') d",[table])).rows[0];
  expect(p,table+' restricted baseline').toEqual({s:true,i:false,u:false,d:false});
 }
 const proposal=readFileSync('docs/engineering/estimating-budget-access-REVIEW-ONLY.sql','utf8').replace(/\r\n/g,'\n');
 expect(createHash('sha256').update(proposal).digest('hex')).toBe(proposalHash);
 await sql(proposal); // The exact reviewed transaction, LOCAL fixture only.
 state.pool=new Pool({...options,max:8});
});
afterAll(async()=>{await state.pool?.end();await admin.end();});
async function restricted(s:string,a?:any[],role='oi_pr2_api'){
 if(!['oi_pr2_api','anon','authenticated'].includes(role))throw Error('Unexpected local test role');
 const c=await admin.connect();try{await c.query('SET ROLE '+role);return await c.query(s,a);}finally{await c.query('RESET ROLE');c.release();}
}
async function user(org=randomUUID(),role='admin'){
 const id=randomUUID();await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic estimating test','customer') ON CONFLICT DO NOTHING",[org]);
 await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic local user',$4,'not-a-real-password')",[id,org,id+'@example.invalid',role]);
 return {id,org,token:jwt.sign({userId:id,organizationId:org,role,sessionVersion:0},process.env.JWT_SECRET!)};
}
async function fixture(){
 const owner=await user(),provider=await user(),other=await user(),portfolio=randomUUID(),property=randomUUID(),building=randomUUID(),opening=randomUUID();
 await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')",[portfolio,owner.org]);
 await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic property')",[property,portfolio]);
 await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')",[building,property]);
 await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,opening_configuration) VALUES($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'door','pair')",[opening,building]);
 const parts=[];for(const leafRole of ['active','inactive']){const leaf=randomUUID(),component=randomUUID();
  await sql("INSERT INTO door_leaves(id,opening_id,leaf_role,condition) VALUES($1,$2,$3,'good')",[leaf,opening,leafRole]);
  await sql("INSERT INTO hardware_components(id,opening_id,component_type,tracker_id,mounting_scope,door_leaf_id,condition) VALUES($1::uuid,$2,'closer',($1::uuid)::text,'door_leaf',$3,'good')",[component,opening,leaf]);parts.push({leaf,component,leafRole});}
 await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)',[property,provider.org,owner.id]);
 const post=(path:string,b:any,u=provider)=>request(app).post(path).set('Authorization','Bearer '+u.token).send(b);
 const get=(path:string,u=owner)=>request(app).get(path).set('Authorization','Bearer '+u.token);
 const doc={id:randomUUID(),version_id:randomUUID(),expected_version:0,property_id:null,title:'Synthetic cut sheet',kind:'cut_sheet',pdf_base64:Buffer.from('%PDF-1.4\nSynthetic local evidence only\n%%EOF').toString('base64')};
 const catalog={id:randomUUID(),version_id:randomUUID(),expected_version:0,sku:'LOCAL-SKU',description:'Synthetic closer',manufacturer:'Synthetic',model:'Test-1',component_type:'closer',currency:'USD',minor_unit_digits:2,unit_price_minor:1234,unit_label:'each',installation_minutes_per_unit:45,pricing_as_of:'2026-10-26T00:00:00Z',installation_source:'Synthetic installation sheet',document_version_ids:[doc.version_id]};
 const estimate={id:randomUUID(),version_id:randomUUID(),expected_version:0,opening_id:opening,currency:'USD',minor_unit_digits:2,expires_at:'2099-01-01T00:00:00Z',parts:[{component_id:parts[1].component,catalog_version_id:catalog.version_id,quantity:2}],labor:{kind:'per_sku_hourly',rate_minor:9000},tax_minor:200,fees_minor:300,tax_note:'Synthetic tax input',fees_note:'Synthetic fees input',note:'Not a quote or commitment'};
 const baseLine={fiscal_period:'2027',intervention:'replace',review_date:null,low_minor:16000,high_minor:18000,contingency_minor:100,intervention_base_minor:null,basis:'Synthetic estimated replacement'};
 const budget={id:randomUUID(),version_id:randomUUID(),expected_version:0,opening_id:opening,label:'Synthetic facility budget',assumptions:'Planning only; no financial authority',lines:[{...baseLine,estimate_version_id:estimate.version_id}]};
 const facilityBudget={...budget,id:randomUUID(),version_id:randomUUID(),lines:[{...baseLine,source:'facility_best_guess',component_id:parts[0].component,currency:'USD',minor_unit_digits:2,as_of_date:'2026-10-26',amount_scope:'selected_component_total',intervention_base_minor:4500,contingency_minor:0,low_minor:4000,high_minor:5000}]};
 const pipeline=async()=>{for(const [path,b] of [['/api/commercial/documents',doc],['/api/commercial/catalog',catalog],['/api/commercial/estimates',estimate]] as const){const r=await post(path,b);expect(r.status,path+' '+r.body.error).toBe(200);}const saved=await post('/api/sandbox-finance/budgets',budget,owner);expect(saved.status,'budget '+saved.body.error).toBe(200);return saved;};
 return {owner,provider,other,property,opening,parts,post,get,doc,catalog,estimate,budget,facilityBudget,pipeline};
}
it('grants only the nine input INSERTs and four head counters, with browser and financial writes denied',async()=>{
 for(const table of inputTables){expect((await sql("SELECT has_table_privilege('oi_pr2_api',$1,'SELECT') s,has_table_privilege('oi_pr2_api',$1,'INSERT') i,has_table_privilege('oi_pr2_api',$1,'UPDATE') u,has_table_privilege('oi_pr2_api',$1,'DELETE') d",[table])).rows[0]).toEqual({s:true,i:true,u:false,d:false});
  for(const role of ['anon','authenticated'])expect((await sql('SELECT has_table_privilege($1,$2,\'SELECT\') s,has_table_privilege($1,$2,\'INSERT\') i,has_table_privilege($1,$2,\'UPDATE\') u,has_table_privilege($1,$2,\'DELETE\') d',[role,table])).rows[0]).toEqual({s:false,i:false,u:false,d:false});}
 for(const table of heads){expect((await sql("SELECT has_column_privilege('oi_pr2_api',$1,'head_version','UPDATE') h,has_column_privilege('oi_pr2_api',$1,'id','UPDATE') id",[table])).rows[0]).toEqual({h:true,id:false});}
 for(const table of held)for(const action of ['INSERT','UPDATE','DELETE'])expect((await sql("SELECT has_table_privilege('oi_pr2_api',$1,$2) allowed",[table,action])).rows[0].allowed).toBe(false);
 for(const role of ['anon','authenticated'])await expect(restricted('SELECT * FROM commercial_document_versions',[],role)).rejects.toMatchObject({code:'42501'});
});
it('saves synthetic private-document, SKU time/rate, estimate and facility budget under the restricted API role',async()=>{
 const f=await fixture(),saved=await f.pipeline();
 const estimate=(await f.get('/api/commercial/context/'+f.opening)).body.estimates.find((x:any)=>x.id===f.estimate.version_id);
 expect(estimate.snapshot.totals).toEqual({parts_known_minor:2468,labor_minor:13500,total_minor:16468,missing:[]});
 expect(estimate.snapshot.parts[0].component).toMatchObject({id:f.parts[1].component,door_leaf_id:f.parts[1].leaf});
 expect(estimate.snapshot).toMatchObject({review_only:true,price_basis:'provider_estimate_not_binding_quote'});
 expect(saved.body.snapshot).toMatchObject({sandbox:true,financial_authority:false,totals:{base_minor:16568}});
 const facility=await f.post('/api/sandbox-finance/budgets',f.facilityBudget,f.owner);expect(facility.status).toBe(200);expect(facility.body.snapshot.totals.base_minor).toBe(4500);
 expect(facility.body.snapshot.lines[0]).toMatchObject({quote:false,entered_by:f.owner.id,organization_id:f.owner.org,target:{component_id:f.parts[0].component}});
 const context=await f.get('/api/sandbox-finance/'+f.opening);expect(context.status).toBe(200);expect(context.body).toMatchObject({budget_writes_enabled:true,cost_writes_enabled:false,payment_execution_available:false,commitments:null,recognized_actuals:null});
});
it('replays exact versions, rejects changed retries/stale heads, and preserves original document/catalog/estimate/budget versions',async()=>{
 const f=await fixture();await f.pipeline();
 const paths=[['/api/commercial/documents',f.doc,f.provider],['/api/commercial/catalog',f.catalog,f.provider],['/api/commercial/estimates',f.estimate,f.provider],['/api/sandbox-finance/budgets',f.budget,f.owner]] as const;
 for(const [path,b,u] of paths){const first=await f.post(path,b,u),repeat=await f.post(path,b,u);expect(first.status).toBe(200);expect(repeat.body).toEqual(first.body);expect((await f.post(path,{...b,version_id:randomUUID()},u)).body.error).toBe('version_conflict');}
 expect((await f.post('/api/commercial/catalog',{...f.catalog,description:'changed'})).body.error).toBe('version_id_reused');
 expect((await f.post('/api/sandbox-finance/budgets',{...f.budget,label:'changed'},f.owner)).body.error).toBe('operation_reused');
 const d2={...f.doc,version_id:randomUUID(),expected_version:1,pdf_base64:Buffer.from('%PDF-1.4\nChanged synthetic evidence\n%%EOF').toString('base64')};expect((await f.post('/api/commercial/documents',d2)).status).toBe(200);
 const c2={...f.catalog,version_id:randomUUID(),expected_version:1,unit_price_minor:9999,installation_minutes_per_unit:60,document_version_ids:[d2.version_id]};expect((await f.post('/api/commercial/catalog',c2)).status).toBe(200);
 const e2={...f.estimate,version_id:randomUUID(),expected_version:1,parts:[{...f.estimate.parts[0],catalog_version_id:c2.version_id}]};expect((await f.post('/api/commercial/estimates',e2)).status).toBe(200);
 const b2={...f.budget,version_id:randomUUID(),expected_version:1,label:'Updated synthetic assumptions'};expect((await f.post('/api/sandbox-finance/budgets',b2,f.owner)).status).toBe(200);
 expect((await f.get('/api/commercial/documents/'+f.doc.version_id,f.provider)).body.pdf_base64).toBe(f.doc.pdf_base64);
 const old=(await f.get('/api/commercial/context/'+f.opening)).body.estimates.find((x:any)=>x.id===f.estimate.version_id);expect(old.snapshot.parts[0].catalog.unit_price_minor).toBe(1234);expect(old.snapshot.document_version_ids).toEqual([f.doc.version_id]);expect(old.snapshot.totals.total_minor).toBe(16468);
 expect((await f.get('/api/sandbox-finance/'+f.opening)).body.budgets.find((x:any)=>x.id===f.budget.version_id).snapshot.label).toBe(f.budget.label);
 for(const [table,id] of [['commercial_document_versions',f.doc.version_id],['provider_catalog_versions',f.catalog.version_id],['replacement_estimate_versions',f.estimate.version_id],['sandbox_budget_versions',f.budget.version_id]])expect((await sql(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`,[id])).rows[0].n).toBe(1);
});
it('rejects wrong tenants/components, another actor replay and revoked provider estimate saves',async()=>{
 const f=await fixture(),other=await fixture();await f.pipeline();
 expect((await f.get('/api/commercial/context/'+f.opening,f.other)).status).toBe(404);
 expect((await f.post('/api/commercial/estimates',f.estimate,f.other)).status).toBe(404);
 expect((await f.post('/api/sandbox-finance/budgets',f.budget,f.other)).status).toBe(404);
 expect((await f.post('/api/commercial/catalog',f.catalog,f.other)).status).toBe(404);
 const bad={...f.estimate,id:randomUUID(),version_id:randomUUID(),parts:[{...f.estimate.parts[0],component_id:other.parts[0].component}]};expect((await f.post('/api/commercial/estimates',bad)).body.error).toBe('component_not_current');
 const budget={...f.facilityBudget,id:randomUUID(),version_id:randomUUID(),lines:[{...f.facilityBudget.lines[0],component_id:other.parts[0].component}]};expect((await f.post('/api/sandbox-finance/budgets',budget,f.owner)).body.error).toBe('component_not_in_facility');
 expect((await f.post('/api/commercial/catalog',f.catalog,await user(f.provider.org))).body.error).toBe('version_id_reused');
 await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1',[f.property]);expect((await f.post('/api/commercial/estimates',f.estimate)).status).toBe(404);
});
it('keeps missing inputs unknown and rejects unavailable document objects without a saved version',async()=>{
 const f=await fixture();await f.pipeline();
 const missing={...f.catalog,id:randomUUID(),version_id:randomUUID(),sku:'UNKNOWN',unit_price_minor:null,installation_minutes_per_unit:null};expect((await f.post('/api/commercial/catalog',missing)).status).toBe(200);
 const estimate={...f.estimate,id:randomUUID(),version_id:randomUUID(),parts:[{...f.estimate.parts[0],catalog_version_id:missing.version_id}]};const r=await f.post('/api/commercial/estimates',estimate);expect(r.status).toBe(200);expect(r.body.snapshot.totals.total_minor).toBeNull();expect(r.body.snapshot.totals.missing).toContain('labor');
 const budget={...f.budget,id:randomUUID(),version_id:randomUUID(),lines:[{...f.budget.lines[0],estimate_version_id:estimate.version_id,low_minor:null,high_minor:null}]};expect((await f.post('/api/sandbox-finance/budgets',budget,f.owner)).body.snapshot.totals.base_minor).toBeNull();
 const absent={...f.catalog,id:randomUUID(),version_id:randomUUID(),sku:'MISSING-DOC',document_version_ids:[randomUUID()]};expect((await f.post('/api/commercial/catalog',absent)).body.error).toBe('verified_private_document_required');
 expect((await sql('SELECT count(*)::int n FROM provider_catalog_versions WHERE id=$1',[absent.version_id])).rows[0].n).toBe(0);
});
it('denies immutable UPDATE/DELETE, non-head changes and held review/PO/cost paths',async()=>{
 const f=await fixture();await f.pipeline();
 const ids=[f.doc.version_id,f.catalog.version_id,f.estimate.version_id,f.budget.version_id];
 for(const [i,table] of versions.entries()){await expect(restricted(`UPDATE ${table} SET id=id WHERE id=$1`,[ids[i]])).rejects.toMatchObject({code:'42501'});await expect(restricted(`DELETE FROM ${table} WHERE id=$1`,[ids[i]])).rejects.toMatchObject({code:'42501'});}
 await expect(restricted('UPDATE commercial_documents SET title=title WHERE id=$1',[f.doc.id])).rejects.toMatchObject({code:'42501'});
 for(const table of held)await expect(restricted(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toMatchObject({code:'42501'});
 expect((await f.post('/api/commercial/estimates/'+f.estimate.version_id+'/review',{operation_id:randomUUID(),note:'Must remain held'},f.owner)).body.error).toBe('commercial_write_held');
 expect((await f.post('/api/planning/versions',{},f.owner)).body.error).toBe('planning_sandbox_disabled');
 expect((await f.post('/api/sandbox-finance/cost-records',{},f.owner)).body.error).toBe('planning_sandbox_disabled');
 for(const role of ['viewer','technician','inspector'])expect((await f.post('/api/sandbox-finance/budgets',f.facilityBudget,await user(f.owner.org,role))).status).toBe(403);
 expect((await sql('SELECT count(*)::int n FROM hardware_components WHERE opening_id=$1 AND condition=\'good\'',[f.opening])).rows[0].n).toBe(2);
});
