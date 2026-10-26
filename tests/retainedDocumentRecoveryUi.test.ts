// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state=vi.hoisted(()=>({api:vi.fn(),principal:{userId:'a',organizationId:'a-org',role:'admin',token:'fake'}}));
vi.mock('../facility-dashboard/api-client.mjs',()=>({api:state.api,readFieldSession:async()=>state.principal}));
it('exposes only enabled recovery, blocks duplicate clicks and removes controls on account change',async()=>{
 let sessionCheck:any;vi.spyOn(globalThis,'setInterval').mockImplementation((fn:any)=>{sessionCheck=fn;return 0 as any;});
 document.documentElement.innerHTML=readFileSync('facility-dashboard/commercial.html','utf8');history.replaceState(null,'','?opening=fixture');
 const data={opening_code:'fixture',owner:true,storage_available:true,retained_recovery_available:true,documents:[],catalog:[],components:[],estimates:[]};
 let finish:any;state.api.mockImplementation(async(_path:string,b:any)=>b?new Promise(resolve=>{finish=resolve;}):data);
 await import('../facility-dashboard/commercial.mjs');
 const button=document.getElementById('recoverRetained') as HTMLButtonElement;
 expect(document.getElementById('retainedRecovery')!.hidden).toBe(false);button.click();button.click();expect(state.api.mock.calls.filter(c=>c[1])).toHaveLength(1);expect(button.disabled).toBe(true);
 finish({recovered:true});await vi.waitFor(()=>expect(button.disabled).toBe(false));
 state.principal={...state.principal,userId:'b',organizationId:'b-org'};await sessionCheck();expect(document.getElementById('recoverRetained')).toBeNull();expect(document.getElementById('status')!.textContent).toBe('Session changed.');vi.restoreAllMocks();
});
