// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state=vi.hoisted(()=>({api:vi.fn(),session:vi.fn()}));
vi.mock('../facility-dashboard/api-client.mjs',()=>({api:state.api,readFieldSession:state.session}));
const principal={userId:'a',organizationId:'org-a',role:'admin',token:'synthetic-secret-not-for-export'};
let interval:()=>Promise<void>,blobs:Blob[],downloads:string[];
const projection=()=>({opening_id:'opening-a',property_id:'facility-a',as_of:'2026-10-26T12:00:00Z',method:'sandbox-evidence-reconciliation-v1',sandbox_enabled:false,estimates:['a','b'].map(id=>({id:'estimate-'+id,opening_id:'opening-'+id,opening_code:id,expired:false,superseded:false,snapshot:{currency:'USD',totals:{total_minor:null,missing:['labor']}}})),budgets:[{id:'budget-version',series_id:'series',version:1,is_current:true,snapshot_hash:'synthetic-hash',snapshot:{label:'Alternative',assumptions:'Confirm labor costs',currency:'USD',minor_unit_digits:2,totals:{low_minor:0,base_minor:null,high_minor:null},lines:[{estimate_version_id:'estimate-b',fiscal_period:'2027',intervention:'inspect',base_minor:null,contingency_minor:null,basis:'Missing labor quote',estimate:{totals:{missing:['labor']}}}]},source_status:[{estimate_version_id:'estimate-b',expired:false,superseded:false}]}],records:[{id:'invoice-a',opening_id:'opening-a',kind:'invoice',correction_of:null,recorded_at:'2026-10-25T10:00:00Z',payload:{reference:'Synthetic invoice',amount_minor:null,currency:'USD',evidence_date:'2026-10-25',source_reference:'Synthetic invoice record',estimate_version_id:'estimate-a',document_version_id:null,verified_document:null,disputed:true}}],reconciliation:[{reference:'Synthetic invoice',recorded_gross_minor:null,recorded_credit_minor:0,recorded_net_invoice_minor:null,recorded_payment_evidence_minor:0,recorded_unpaid_difference_minor:null,currency:'USD',minor_unit_digits:2,exceptions:['amount_unknown','disputed']}],commitments:null,recognized_actuals:null,combined_spend_total:null,payment_execution_available:false});
beforeEach(()=>{
 vi.resetModules();state.api.mockReset();state.session.mockReset();state.session.mockResolvedValue(principal);blobs=[];downloads=[];
 vi.spyOn(globalThis,'setInterval').mockImplementation((fn:any)=>{interval=fn;return 0 as any;});
 vi.stubGlobal('URL',class extends URL {static createObjectURL(b:Blob){blobs.push(b);return 'blob:synthetic-local';}static revokeObjectURL(){}});
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){downloads.push(this.download);});
 document.documentElement.innerHTML=readFileSync('facility-dashboard/finance.html','utf8');history.replaceState(null,'','?opening=opening-a');state.api.mockResolvedValue(projection());
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const button=()=>document.getElementById('exportReport') as HTMLButtonElement;
async function blobText(blob:Blob){return new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsText(blob);});}
it('exports the property-wide saved evidence with exact source associations, unknowns and no invented total',async()=>{
 const p=projection();state.api.mockResolvedValue({...p,runtime_secret:'must-not-export',session:principal,private_url:'private-runtime-url'});
 await import('../facility-dashboard/finance.mjs');button().click();await vi.waitFor(()=>expect(blobs).toHaveLength(1));const raw=await blobText(blobs[0]),report=JSON.parse(raw);
 expect(report.property_id).toBe('facility-a');expect(report.access_anchor_opening_id).toBe('opening-a');expect(report.scope).toBe('one_facility_recorded_sandbox_evidence');expect(report.as_of).toBe(p.as_of);expect(report.method).toBe(p.method);
 for(const k of ['estimates','budgets','records','reconciliation','commitments','recognized_actuals','combined_spend_total','payment_execution_available'])expect(report[k]).toEqual((p as any)[k]);
 expect(report.estimates.map((e:any)=>e.opening_id)).toEqual(['opening-a','opening-b']);expect(report.budgets[0].snapshot.totals.low_minor).toBe(0);expect(report.budgets[0].snapshot.totals.base_minor).toBeNull();
 expect(raw).not.toContain(principal.token);expect(raw).not.toContain('must-not-export');expect(raw).not.toContain('private-runtime-url');expect(downloads).toEqual(['facility-sandbox-evidence-report.json']);expect(state.api).toHaveBeenCalledTimes(1);
});
it('does not export before the complete response is loaded',async()=>{
 let release!:(v:any)=>void;state.api.mockImplementation(()=>new Promise(r=>release=r));const load=import('../facility-dashboard/finance.mjs');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));expect(button().disabled).toBe(true);button().click();expect(blobs).toHaveLength(0);release(projection());await load;expect(button().disabled).toBe(false);
});
it('does not silently export a partial or failed response',async()=>{
 state.api.mockResolvedValue({...projection(),records:null});await import('../facility-dashboard/finance.mjs');expect(button().disabled).toBe(true);button().click();expect(blobs).toHaveLength(0);
});
it('blocks stale account export before the periodic check runs',async()=>{
 await import('../facility-dashboard/finance.mjs');state.session.mockResolvedValue({...principal,organizationId:'org-b'});button().click();await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Account changed'));expect(blobs).toHaveLength(0);expect(button().disabled).toBe(true);expect(document.getElementById('content')!.children).toHaveLength(0);
});
it('does not restore a response after the account changes during load',async()=>{
 let release!:(v:any)=>void;state.api.mockImplementation(()=>new Promise(r=>release=r));const load=import('../facility-dashboard/finance.mjs');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));state.session.mockResolvedValue(null);await interval();release(projection());await load;expect(button().disabled).toBe(true);expect(document.getElementById('content')!.children).toHaveLength(0);expect(blobs).toHaveLength(0);
});
it('disables export after a failed refresh and after account loss',async()=>{
 await import('../facility-dashboard/finance.mjs');state.api.mockRejectedValue(Error('Synthetic read failure'));(document.getElementById('reload') as HTMLButtonElement).click();await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Synthetic read failure'));expect(button().disabled).toBe(true);state.session.mockResolvedValue(null);await interval();button().click();expect(blobs).toHaveLength(0);
});
it('cancels an in-progress export if its saved response is replaced',async()=>{
 await import('../facility-dashboard/finance.mjs');let release!:(v:any)=>void;state.session.mockImplementationOnce(()=>new Promise(r=>release=r));button().click();(document.getElementById('reload') as HTMLButtonElement).click();await vi.waitFor(()=>expect(state.api).toHaveBeenCalledTimes(2));release(principal);await vi.waitFor(()=>expect(button().disabled).toBe(false));expect(blobs).toHaveLength(0);
});
it('refuses export while an uncertain mutation is pending',async()=>{
 state.api.mockImplementation(async(_p:string,body:any)=>{if(body)throw Error('Synthetic write outcome unknown');return {...projection(),sandbox_enabled:true};});
 await import('../facility-dashboard/finance.mjs');(document.getElementById('budgetForm') as HTMLFormElement).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Synthetic write outcome unknown'));expect(button().disabled).toBe(true);button().click();expect(blobs).toHaveLength(0);expect(state.api).toHaveBeenCalledTimes(2);
});
it('cancels export when a write begins during its account check',async()=>{
 state.api.mockImplementation(async(_p:string,body:any)=>{if(body)throw Error('Synthetic write outcome unknown');return {...projection(),sandbox_enabled:true};});
 await import('../facility-dashboard/finance.mjs');let release!:(v:any)=>void;state.session.mockImplementationOnce(()=>new Promise(r=>release=r));button().click();(document.getElementById('budgetForm') as HTMLFormElement).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Synthetic write outcome unknown'));release(principal);await new Promise(r=>setTimeout(r,0));expect(button().disabled).toBe(true);expect(blobs).toHaveLength(0);
});
