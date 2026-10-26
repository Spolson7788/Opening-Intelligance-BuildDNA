// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state=vi.hoisted(()=>({api:vi.fn(),session:vi.fn()}));
vi.mock('../facility-dashboard/api-client.mjs',()=>({api:state.api,readFieldSession:state.session}));
const principal={userId:'a',organizationId:'org-a',role:'admin',token:'synthetic-secret-not-for-export'};
let interval:()=>Promise<void>,blobs:Blob[],downloads:string[];
const projection=()=>({opening_id:'opening-a',opening_code:'A / unsafe filename',as_of:'2026-10-26T12:00:00Z',sandbox_enabled:false,configuration_gaps:['named_approver_and_authority_limits'],condition:{method:'recorded-condition-v1',threshold:12,excluded_manufacturer_count:1,cohorts:[{manufacturer:'Synthetic',model:'A',component_type:'closer',installed:2,assessed:1,worn_failed:1,unverified:1,rate:null,rate_withheld:true}]},lifecycle:{current_component_count:2,installation_unknown_count:1,recorded_replacements:1,service_event_count:1,service_event_ids:['event-source'],replacement_ids:['replacement-source'],exposure_component_years:null,downtime:{}},versions:[{plan_id:'plan',version:1,is_current:true,snapshot_hash:'synthetic-hash',snapshot:{label:'Draft',kind:'scenario',estimate_version_id:'estimate-source',fiscal_period:'2027',assumptions:'Inspect before replacing; missing labor',estimate:{totals:{total_minor:null,missing:['labor']},currency:'USD',minor_unit_digits:2}},review_requested:false,estimate_expired:true}],events:[],financial:{approved_reservation_minor:null,issued_commitment_minor:null,recognized_actual_minor:null,combined_total_minor:null,status:'unavailable'}});
beforeEach(()=>{
 vi.resetModules();state.api.mockReset();state.session.mockReset();state.session.mockResolvedValue(principal);blobs=[];downloads=[];
 vi.spyOn(globalThis,'setInterval').mockImplementation((fn:any)=>{interval=fn;return 0 as any;});
 vi.stubGlobal('URL',class extends URL {static createObjectURL(b:Blob){blobs.push(b);return 'blob:synthetic-local';}static revokeObjectURL(){}});
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){downloads.push(this.download);});
 document.documentElement.innerHTML=readFileSync('facility-dashboard/planning.html','utf8');history.replaceState(null,'','?opening=opening-a');
 state.api.mockImplementation(async(p:string)=>p.startsWith('/planning/')?projection():{estimates:[],runtime_secret:'must-not-export'});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const button=()=>document.getElementById('exportReport') as HTMLButtonElement;
async function blobText(blob:Blob){return new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsText(blob);});}
it('exports saved opening assumptions, source IDs, unknowns and as-of without session or commercial context',async()=>{
 await import('../facility-dashboard/planning.mjs');expect(button().disabled).toBe(false);const requestCount=state.api.mock.calls.length;button().click();await vi.waitFor(()=>expect(blobs).toHaveLength(1));
 const text=await blobText(blobs[0]),report=JSON.parse(text),p=projection();
 expect(report.scope).toBe('one_opening');expect(report.as_of).toBe(p.as_of);expect(report.condition).toEqual(p.condition);expect(report.lifecycle).toEqual(p.lifecycle);expect(report.versions).toEqual(p.versions);expect(report.financial).toEqual(p.financial);expect(report.configuration_gaps).toEqual(p.configuration_gaps);
 expect(text).not.toContain(principal.token);expect(text).not.toContain('must-not-export');expect(downloads).toEqual(['opening-planning-report.json']);expect(state.api.mock.calls).toHaveLength(requestCount);
});
it('cannot export before the initial load finishes',async()=>{
 let release!:(v:any)=>void;state.api.mockImplementation((p:string)=>p.startsWith('/planning/')?new Promise(r=>release=r):Promise.resolve({estimates:[]}));
 const load=import('../facility-dashboard/planning.mjs');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));expect(button().disabled).toBe(true);button().click();expect(blobs).toHaveLength(0);release(projection());await load;expect(button().disabled).toBe(false);
});
it('rechecks account immediately before export and clears the stale view',async()=>{
 await import('../facility-dashboard/planning.mjs');state.session.mockResolvedValue({...principal,userId:'b'});button().click();await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Account changed'));expect(blobs).toHaveLength(0);expect(button().disabled).toBe(true);expect(document.getElementById('content')!.children).toHaveLength(0);
});
it('disables export after periodic account loss and after a failed refresh',async()=>{
 await import('../facility-dashboard/planning.mjs');state.api.mockRejectedValue(Error('Synthetic failure'));(document.getElementById('reload') as HTMLButtonElement).click();await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Synthetic failure'));expect(button().disabled).toBe(true);button().click();expect(blobs).toHaveLength(0);
 state.session.mockResolvedValue(null);await interval();expect(button().disabled).toBe(true);expect(document.getElementById('content')!.children).toHaveLength(0);
});
it('does not export an old snapshot if refresh starts while the account check is pending',async()=>{
 await import('../facility-dashboard/planning.mjs');let release!:(v:any)=>void;state.session.mockImplementationOnce(()=>new Promise(r=>release=r));button().click();expect(button().disabled).toBe(true);
 (document.getElementById('reload') as HTMLButtonElement).click();await vi.waitFor(()=>expect(state.api.mock.calls).toHaveLength(4));release(principal);await vi.waitFor(()=>expect(button().disabled).toBe(false));expect(blobs).toHaveLength(0);
});
