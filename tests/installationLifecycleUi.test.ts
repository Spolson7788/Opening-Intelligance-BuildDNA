// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement,act} from '../field-app/node_modules/react';
import {createRoot} from '../field-app/node_modules/react-dom/client';
const state=vi.hoisted(()=>({auth:{userId:'u',organizationId:'o',role:'admin'},load:vi.fn(),save:vi.fn()}));
vi.mock('../field-app/node_modules/react-router-dom/dist/index.js',()=>({useParams:()=>({id:'opening-a'}),Link:({children}:any)=>children}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>({auth:state.auth})}));
vi.mock('../field-app/src/lib/api',()=>({fetchLifecycle:state.load,saveInstallationFact:state.save}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:async()=>state.auth}));
import {InstallationLifecyclePage} from '../field-app/src/pages/InstallationLifecyclePage';
let root:ReturnType<typeof createRoot>,host:HTMLDivElement;
const data=()=>({opening_id:'opening-a',opening_code:'A',status:'active',revision:3,frames:[],door_leaves:[],hardware_components:[],installation_facts:[],legacy_installation_dates:[{target:{type:'opening',id:'opening-a'},date:'2010-03-14',review_state:'unreviewed'}],service_events:[{id:'original-service',event_date:'2020-01-01',work_performed:'Original historical service'}]});
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;state.auth={userId:'u',organizationId:'o',role:'admin'};state.load.mockResolvedValue(data());host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.resetAllMocks();});
it('shows an unknown installation anchor before original services and keeps legacy dates unreviewed',async()=>{
 await act(async()=>root.render(createElement(InstallationLifecyclePage)));
 expect(host.textContent).toContain('Installation date unknown');expect(host.textContent).toContain('Legacy date 2010-03-14 — unreviewed');
 expect(host.textContent!.indexOf('Installation date unknown')).toBeLessThan(host.textContent!.indexOf('Original historical service'));
});
it('freezes an uncertain submission and retries exactly the same operation and payload',async()=>{
 state.save.mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValueOnce({});
 await act(async()=>root.render(createElement(InstallationLifecyclePage)));
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.querySelector('fieldset')!.disabled).toBe(true);expect(host.textContent).toContain('Retry identical submission');
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(state.save).toHaveBeenCalledTimes(2);expect(state.save.mock.calls[0]).toEqual(state.save.mock.calls[1]);
 expect(state.save.mock.calls[0][0].payload.date).toEqual({certainty:'unknown',precision:'unknown',year:null,month:null,day:null});
});
it('does not carry installation content into another account and keeps technician writes unavailable',async()=>{
 await act(async()=>root.render(createElement(InstallationLifecyclePage)));
 state.auth={userId:'new',organizationId:'new',role:'technician'};state.load.mockReturnValueOnce(new Promise(()=>{}));
 await act(async()=>root.render(createElement(InstallationLifecyclePage)));
 expect(host.textContent).not.toContain('Original historical service');expect(host.querySelector('form')).toBeNull();
});
it('resets a removed target on reload before allowing another installation submission',async()=>{
 const initial=data();(initial.hardware_components as any[]).push({id:'removed-component',component_type:'closer',mounting_scope:'opening'});
 state.load.mockResolvedValueOnce(initial).mockResolvedValue(data());state.save.mockResolvedValue({});
 await act(async()=>root.render(createElement(InstallationLifecyclePage)));
 const target=host.querySelector('select')!;
 await act(async()=>{target.value='component:removed-component';target.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Reload saved facts')!.click());
 expect(host.querySelector('select')!.value).toBe('opening:opening-a');
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(state.save.mock.calls[0][0].payload.target).toEqual({type:'opening',id:'opening-a'});
});
