import {it,expect} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app';
import {pool} from '../src/db/pool';
import {signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {reconcileCosts} from '../src/services/costReconciliation';
import {canonicalPayloadHash} from '../src/services/syncProtocol';
async function fixture(){
 const owner=await signupTestOrg(),other=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token),o=await createTestOpening(owner.token,scope.buildingId),second=await createTestOpening(owner.token,scope.buildingId),api=createApp({planningSandboxEnabled:true});
 const actor=(await pool.query('SELECT id FROM users WHERE email=$1',[owner.email])).rows[0].id;
 async function quote(opening=o.id,currency='USD',component=randomUUID(),amount:number|null=1000){const id=randomUUID(),version=randomUUID();await pool.query('INSERT INTO replacement_estimates(id,provider_id,opening_id,head_version) VALUES($1,$2,$3,1)',[id,owner.organizationId,opening]);const snapshot={expires_at:'2099-01-01T00:00:00Z',currency,minor_unit_digits:2,parts:[{component_id:component}],totals:{total_minor:amount,missing:amount===null?['labor']:[]}};await pool.query('INSERT INTO replacement_estimate_versions(id,estimate_id,version,snapshot,recorded_by,request_hash) VALUES($1,$2,1,$3,$4,$5)',[version,id,JSON.stringify(snapshot),actor,'synthetic']);return version;}
 const estimate=await quote(),secondEstimate=await quote(second.id);
 const post=(path:string,b:any,token=owner.token)=>request(api).post('/api/sandbox-finance'+path).set('Authorization','Bearer '+token).send(b);
 const get=(token=owner.token)=>request(api).get('/api/sandbox-finance/'+o.id).set('Authorization','Bearer '+token);
 const line=(id=estimate)=>({estimate_version_id:id,fiscal_period:'FY2027',intervention:'replace',review_date:null,low_minor:900,high_minor:1200,contingency_minor:100,basis:'Synthetic explicit range'});
 const budget=()=>({id:randomUUID(),version_id:randomUUID(),expected_version:0,opening_id:o.id,label:'Synthetic facility scenario',assumptions:'No financial authority',lines:[line(),line(secondEstimate)]});
 const cost=()=>({id:randomUUID(),opening_id:o.id,kind:'invoice',invoice_id:null,correction_of:null,correction_reason:'',estimate_version_id:estimate,provider_id:owner.organizationId,budget_version_id:null,reference:'INV-'+randomUUID(),evidence_date:'2026-10-23',currency:'USD',minor_unit_digits:2,amount_minor:1000,disputed:false,source_reference:'Synthetic invoice fixture',document_version_id:null,note:''});
 return {owner,other,o,second,api,estimate,quote,post,get,line,budget,cost};
}
it('versions multi-opening facility scenarios with exact ranges, missing coverage and no overlap/FX',async()=>{
 const f=await fixture(),b=f.budget(),first=await f.post('/budgets',b);expect(first.status).toBe(200);expect(first.body.snapshot.totals).toEqual({low_minor:1800,base_minor:2200,high_minor:2400});expect(first.body.snapshot_hash).toBe(canonicalPayloadHash(first.body.snapshot));expect((await f.post('/budgets',b)).body).toEqual(first.body);
 expect((await f.post('/budgets',{...b,label:'Changed'})).status).toBe(409);expect((await f.post('/budgets',f.budget(),f.other.token)).status).toBe(404);
 const overlap=f.budget();overlap.lines=[f.line(),f.line()];expect((await f.post('/budgets',overlap)).status).toBe(409);
 const fx=f.budget();fx.lines=[f.line(),f.line(await f.quote(f.second.id,'EUR'))];expect((await f.post('/budgets',fx)).body.error).toBe('mixed_currency_or_precision');
 const missing={...b,version_id:randomUUID(),expected_version:1,lines:[{...f.line(),contingency_minor:null}]};const saved=await f.post('/budgets',missing);expect(saved.body.snapshot.totals.base_minor).toBeNull();const view=await f.get();expect(view.body.budgets.find((v:any)=>v.id===b.version_id).snapshot.totals.base_minor).toBe(2200);
 const inspect={...f.budget(),lines:[{...f.line(),intervention:'inspect',low_minor:40,high_minor:60,contingency_minor:0,intervention_base_minor:50}]};expect((await f.post('/budgets',inspect)).body.snapshot.totals.base_minor).toBe(50);
 const unknown={...f.budget(),lines:[{...f.line(),intervention:'inspect',low_minor:null,high_minor:null,contingency_minor:0}]};expect((await f.post('/budgets',unknown)).body.snapshot.totals.base_minor).toBeNull();
});
it('reconciles partial invoices, credits and payment evidence without summing forecast or recognizing actuals',async()=>{
 const f=await fixture(),budget=f.budget();await f.post('/budgets',budget);const inv={...f.cost(),budget_version_id:budget.version_id};expect((await f.post('/cost-records',inv)).status).toBe(200);
 const credit={...inv,id:randomUUID(),kind:'credit',invoice_id:inv.id,reference:'CREDIT-1',amount_minor:200};const payment={...inv,id:randomUUID(),kind:'payment',invoice_id:inv.id,reference:'PAYMENT-1',amount_minor:500};expect((await f.post('/cost-records',credit)).status).toBe(200);expect((await f.post('/cost-records',payment)).status).toBe(200);
 const rows=(await f.get()).body;expect(rows.reconciliation[0]).toMatchObject({recorded_gross_minor:1000,recorded_credit_minor:200,recorded_net_invoice_minor:800,recorded_payment_evidence_minor:500,recorded_unpaid_difference_minor:300,recognized_actual_minor:null,committed_minor:null});expect(rows.combined_spend_total).toBeNull();expect(rows.reconciliation[0].exceptions).toEqual(['unverified_source']);
 const correction={...inv,id:randomUUID(),correction_of:inv.id,correction_reason:'Correct source total',amount_minor:1200};expect((await f.post('/cost-records',correction)).status).toBe(200);expect((await f.get()).body.reconciliation[0].recorded_unpaid_difference_minor).toBe(500);
 const unknown={...credit,id:randomUUID(),correction_of:credit.id,correction_reason:'Amount not supported',amount_minor:null};expect((await f.post('/cost-records',unknown)).status).toBe(200);expect((await f.get()).body.reconciliation[0].recorded_net_invoice_minor).toBeNull();
});
it('binds evidence retries, rejects duplicate references, wrong allocations and immutable-history edits',async()=>{
 const f=await fixture(),inv=f.cost(),first=await f.post('/cost-records',inv);expect(first.status).toBe(200);expect((await f.post('/cost-records',inv)).body).toEqual(first.body);expect((await f.post('/cost-records',{...inv,amount_minor:0})).status).toBe(409);expect((await f.post('/cost-records',{...inv,id:randomUUID()})).status).toBe(409);
 expect((await f.get(f.other.token)).status).toBe(404);expect((await f.post('/cost-records',f.cost(),f.other.token)).status).toBe(404);
 const payment={...inv,id:randomUUID(),kind:'payment',invoice_id:inv.id,reference:'PAY-1',amount_minor:500};expect((await f.post('/cost-records',payment)).status).toBe(200);expect((await f.post('/cost-records',{...payment,id:randomUUID()})).status).toBe(409);expect((await f.post('/cost-records',{...payment,id:randomUUID(),currency:'EUR',reference:'BAD'})).status).toBe(409);
 const secondInvoice=f.cost();expect((await f.post('/cost-records',secondInvoice)).status).toBe(200);expect((await f.post('/cost-records',{...payment,id:randomUUID(),invoice_id:secondInvoice.id})).status).toBe(409);
 expect((await f.post('/cost-records',{...f.cost(),document_version_id:randomUUID()})).status).toBe(404);expect((await f.post('/cost-records',{...f.cost(),evidence_date:'2026-02-30'})).status).toBe(422);
 await expect(pool.query("DELETE FROM sandbox_cost_records WHERE id=$1",[inv.id])).rejects.toThrow();
 expect((await request(createApp()).post('/api/sandbox-finance/cost-records').set('Authorization','Bearer '+f.owner.token).send(f.cost())).status).toBe(503);
});
it('flags overpayment, excess credits and disputes rather than clamping or silently allocating',()=>{
 const payload={amount_minor:100,currency:'USD',minor_unit_digits:2,reference:'Invoice',disputed:false,budget_version_id:null,verified_document:null};const invoice={id:'i',kind:'invoice',correction_of:null,payload},credit={id:'c',kind:'credit',invoice_id:'i',payload:{...payload,amount_minor:120}},payment={id:'p',kind:'payment',invoice_id:'i',payload:{...payload,amount_minor:10,disputed:true}};
 const r=reconcileCosts([invoice,credit,payment])[0];expect(r.recorded_unpaid_difference_minor).toBe(-30);expect(r.exceptions).toEqual(expect.arrayContaining(['credits_exceed_invoice','payments_exceed_net_invoice','disputed_evidence','unmatched_budget']));
});

it('records facility best guesses without a provider estimate, preserves unknowns and immutable attribution',async()=>{
 const f=await fixture();const component=randomUUID();await pool.query("INSERT INTO hardware_components(id,opening_id,component_type,tracker_id) VALUES($1,$2,'closer',$3)",[component,f.o.id,'TEST-'+component]);
 const line={source:'facility_best_guess',component_id:component,currency:'USD',minor_unit_digits:2,as_of_date:'2026-10-26',amount_scope:'selected_component_total',fiscal_period:null,intervention:'replace',review_date:null,low_minor:null,high_minor:null,contingency_minor:0,intervention_base_minor:null,basis:'Facility owner best guess; timing and amount not known'};
 const b={...f.budget(),lines:[line]},first=await f.post('/budgets',b);expect(first.status).toBe(200);expect(first.body.snapshot.totals).toEqual({low_minor:null,base_minor:null,high_minor:null});expect(first.body.snapshot.lines[0]).toMatchObject({source:'facility_best_guess',component_id:component,opening_id:f.o.id,organization_id:f.owner.organizationId,quote:false,fiscal_period:null,as_of_date:'2026-10-26',timing_source:'facility_best_guess'});expect(first.body.snapshot.lines[0].entered_by).toBeTruthy();expect(first.body.snapshot.lines[0].estimate).toBeUndefined();expect((await f.post('/budgets',b)).body).toEqual(first.body);
 const next={...b,version_id:randomUUID(),expected_version:1,lines:[{...line,intervention_base_minor:12345,fiscal_period:'Facility guess FY2029',basis:'Updated owner planning assumption'}]};expect((await f.post('/budgets',next)).body.snapshot.totals.base_minor).toBe(12345);
 const view=await f.get();expect(view.status).toBe(200);expect(view.body.budget_targets).toEqual(expect.arrayContaining([expect.objectContaining({component_id:component,opening_id:f.o.id})]));expect(view.body.budgets.find((v:any)=>v.id===b.version_id).snapshot.lines[0].intervention_base_minor).toBeNull();expect(view.body.budgets.find((v:any)=>v.id===b.version_id).source_status[0]).toMatchObject({quote:false,source:'facility_best_guess'});
 expect((await f.post('/budgets',{...f.budget(),lines:[line]},f.other.token)).status).toBe(404);
 for(const bad of [{...line,component_id:randomUUID()},{...line,minor_unit_digits:undefined},{...line,as_of_date:'2026-02-30'},{...line,estimate_version_id:f.estimate},{...line,amount_scope:'per_unit'}])expect([404,422]).toContain((await f.post('/budgets',{...f.budget(),lines:[bad]})).status);
 const overlap={...f.budget(),lines:[line,line]};expect((await f.post('/budgets',overlap)).body.error).toBe('duplicate_component_budget');
 const matchingQuote=await f.quote(f.o.id,'USD',component);expect((await f.post('/budgets',{...f.budget(),lines:[f.line(matchingQuote),line]})).body.error).toBe('duplicate_component_budget');
 expect((await f.post('/budgets',{...f.budget(),lines:[{...line,currency:'EUR'},f.line()]})).body.error).toBe('mixed_currency_or_precision');
 await pool.query("UPDATE openings SET status='decommissioned' WHERE id=$1",[f.o.id]);expect((await f.post('/budgets',{...f.budget(),lines:[line]})).body.error).toBe('component_not_in_facility');const decommissionedView=await f.get();expect(decommissionedView.body.budget_targets.some((t:any)=>t.component_id===component)).toBe(false);expect(decommissionedView.body.budgets.find((v:any)=>v.id===b.version_id).snapshot.lines[0].component_id).toBe(component);
 await pool.query("UPDATE openings SET status='active' WHERE id=$1",[f.o.id]);
 await pool.query("UPDATE hardware_components SET lifecycle_state='retired' WHERE id=$1",[component]);expect((await f.post('/budgets',{...f.budget(),lines:[line]})).body.error).toBe('component_not_in_facility');
});
