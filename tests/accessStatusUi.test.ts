// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state=vi.hoisted(()=>({api:vi.fn(),session:vi.fn()}));
vi.mock('../facility-dashboard/api-client.mjs',()=>({api:state.api,readFieldSession:state.session}));
let interval:()=>Promise<void>;
const principal={userId:'a',organizationId:'org-a',role:'admin',token:'synthetic-local'};
const content=()=>document.getElementById('content') as HTMLElement;
const status=()=>document.getElementById('status')!.textContent;
const projection=(page:string)=>page==='commercial'?{opening_code:'Synthetic',owner:true,documents:[],catalog:[],components:[],estimates:[]}:{opening_id:'a',property_id:'p',as_of:'2026-10-27',method:'synthetic',estimates:[],budgets:[],records:[],reconciliation:[]};
beforeEach(()=>{vi.resetModules();state.api.mockReset();state.session.mockReset();state.session.mockResolvedValue(principal);vi.spyOn(globalThis,'setInterval').mockImplementation((fn:any)=>{interval=fn;return 0 as any;});});
afterEach(()=>vi.restoreAllMocks());
async function boot(page:string){document.documentElement.innerHTML=readFileSync('facility-dashboard/'+page+'.html','utf8');history.replaceState(null,'','?opening=a');return page==='commercial'?import('../facility-dashboard/commercial.mjs'):import('../facility-dashboard/finance.mjs');}
for(const page of ['commercial','finance']){
 it(page+' replaces terminal loading with denial, then supports an explicit successful refresh',async()=>{
  state.api.mockRejectedValueOnce(Error('not_found'));await boot(page);
  expect(status()).toBe('Records unavailable.');expect(content().hidden).toBe(true);expect(state.api).toHaveBeenCalledTimes(1);
  let resolve:(x:any)=>void=()=>{};state.api.mockImplementationOnce(()=>new Promise(r=>resolve=r));(document.getElementById('reload') as HTMLButtonElement).click();
  expect(status()).toContain('Loading');resolve(projection(page));await vi.waitFor(()=>expect(content().hidden).toBe(false));expect(status()).not.toContain('Loading');expect(document.getElementById('error')!.textContent).toBe('');
  state.api.mockRejectedValueOnce(Error('not_found'));(document.getElementById('reload') as HTMLButtonElement).click();await vi.waitFor(()=>expect(status()).toBe('Records unavailable.'));expect(content().hidden).toBe(true);expect(state.api).toHaveBeenCalledTimes(3);
 });
 it(page+' has terminal status when no session exists on navigation',async()=>{state.session.mockResolvedValue(null);await boot(page);expect(status()).toBe('Records unavailable.');expect(state.api).not.toHaveBeenCalled();expect(content().hidden).toBe(true);});
 it(page+' removes loaded records and loading text after an account transition',async()=>{state.api.mockResolvedValue(projection(page));await boot(page);state.session.mockResolvedValue({...principal,userId:'b',organizationId:'org-b'});await interval();expect(status()).toBe('Session changed.');expect(content().textContent).toBe('');expect(state.api).toHaveBeenCalledTimes(1);});
}
