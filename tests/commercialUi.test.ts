// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state=vi.hoisted(()=>({api:vi.fn(),principal:{userId:'owner',organizationId:'org',role:'admin',token:'synthetic'}}));
vi.mock('../facility-dashboard/api-client.mjs',()=>({api:state.api,readFieldSession:async()=>state.principal,requireFacilityOfficePage:async()=>true}));
it('does not silently replay a pending review when a different review is clicked',async()=>{
 vi.spyOn(globalThis,'setInterval').mockReturnValue(0 as any);
 document.documentElement.innerHTML=readFileSync('facility-dashboard/commercial.html','utf8');history.replaceState(null,'','?opening=synthetic-opening');
 const estimate=(id:string)=>({id,estimate_id:id,version:1,head_version:1,provider_id:'provider',stale:false,superseded:false,snapshot:{expires_at:'2099-01-01T00:00:00Z',parts:[],labor:{kind:'fixed',amount_minor:100},tax_minor:0,fees_minor:0,totals:{total_minor:100,missing:[]},currency:'USD',minor_unit_digits:2,document_version_ids:[]}});
 state.api.mockImplementation(async(_path:string,body:any)=>{if(body)throw Error('Synthetic network failure');return {opening_code:'Synthetic',owner:true,storage_available:true,storage_mode:'fixture',documents:[],catalog:[],components:[],estimates:[estimate('a'),estimate('b')]};});
 await import('../facility-dashboard/commercial.mjs');
 const articles=[...document.querySelectorAll('#estimates article')];for(const a of articles)(a.querySelector('input') as HTMLInputElement).value='Synthetic review';
 (articles[0].querySelector('button') as HTMLButtonElement).click();await vi.waitFor(()=>expect(document.getElementById('error')!.textContent).toContain('Synthetic network failure'));
 (articles[1].querySelector('button') as HTMLButtonElement).click();expect(document.getElementById('error')!.textContent).toContain('different submission is pending');
 expect(state.api.mock.calls.filter(c=>c[1])).toHaveLength(1);vi.restoreAllMocks();
});
