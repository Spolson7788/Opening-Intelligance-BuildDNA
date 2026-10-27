import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,useNavigate} from 'react-router-dom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({auth:null as any,loading:false,identityChecking:false,login:vi.fn(),logout:vi.fn(),sync:vi.fn(),provider:vi.fn()}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>state,AuthProvider:({children}:any)=>{state.provider();return children;}}));
vi.mock('../field-app/src/lib/sync',()=>({initSync:state.sync,onSyncStateChange:vi.fn(),queueOpeningMutation:vi.fn()}));
vi.mock('../field-app/src/pages/OpeningDetailPage',()=>({OpeningDetailPage:()=> <p>Protected opening workspace</p>}));
import {FieldApplication} from '../field-app/src/App';
import {fetchPublicOpening} from '../field-app/src/lib/qrLanding';
import {assertSyncDispatchAllowed} from '../field-app/src/lib/syncNavigation';
const token='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const path='/opening/by-qr/'+token;
const names={facility_name:'Synthetic Facility',building_name:'Synthetic Building',opening_code:'SYN-A-PAIR-002'};
let host:HTMLDivElement,root:ReturnType<typeof createRoot>,navigate:ReturnType<typeof useNavigate>;
function Harness(){navigate=useNavigate();return <FieldApplication/>;}
async function render(route=path){await act(async()=>root.render(<MemoryRouter initialEntries={[route]}><Harness/></MemoryRouter>));}
async function go(route:string){await act(async()=>navigate(route));}
const response=(body:any=names,status=200,type='application/json')=>({ok:status===200,status,headers:new Headers({'content-type':type}),json:async()=>body});
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()));state.auth=null;state.loading=false;state.identityChecking=false;state.provider.mockClear();state.sync.mockReset();state.login.mockReset().mockImplementation(async()=>{state.auth={userId:'A',organizationId:'org-A',email:'a@example.invalid'};});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it.each([false,true])('landing exposes only names and never mounts account/sync lifecycle, signed in=%s',async signedIn=>{
  if(signedIn)state.auth={userId:'private-id',organizationId:'private-org',email:'private-email'};
  await render();expect(host.textContent).toContain(names.opening_code);expect(host.textContent).toContain(names.facility_name);expect(host.textContent).toContain(names.building_name);
  expect(host.textContent).not.toContain('private-');expect(state.provider).not.toHaveBeenCalled();expect(state.sync).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith('/api/qr/'+token,expect.objectContaining({cache:'no-store',credentials:'same-origin',redirect:'error'}));
  expect((fetch as any).mock.calls[0][1].headers).toBeUndefined();
  expect(()=>assertSyncDispatchAllowed()).toThrow('sync_navigation_paused');
});
it('preserves protected destination through sign-in without syncing on landing or interrupted sign-in',async()=>{
  await render();await act(async()=>host.querySelector('a')!.click());
  expect(host.textContent).toContain('Field Sign-In');expect(state.sync).not.toHaveBeenCalled();
  await go(path);expect(host.textContent).toContain(names.opening_code);expect(state.sync).not.toHaveBeenCalled();
  await act(async()=>host.querySelector('a')!.click());
  (host.querySelector('#email') as HTMLInputElement).value='a@example.invalid';(host.querySelector('#password') as HTMLInputElement).value='fake-test-only';
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(host.textContent).toContain('Protected opening workspace');expect(state.sync).not.toHaveBeenCalled();
  expect(state.login).toHaveBeenCalledWith('a@example.invalid','fake-test-only',false);
});
it('keeps trailing-slash protected QR routes and their login read-only',async()=>{
  await render(path+'/details/');expect(host.textContent).toContain('Field Sign-In');expect(state.sync).not.toHaveBeenCalled();
  expect(()=>assertSyncDispatchAllowed()).toThrow('sync_navigation_paused');
});
it('does not show stale names when navigating to another QR or resolving a late response',async()=>{
  let resolveFirst!:(r:any)=>void;
  vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>resolveFirst=r));
  await render();const firstSignal=(fetch as any).mock.calls[0][1].signal;
  vi.mocked(fetch).mockResolvedValue(response({...names,opening_code:'SECOND'}) as any);
  await go('/opening/by-qr/'+other);expect(firstSignal.aborted).toBe(true);expect(host.textContent).toContain('SECOND');
  await act(async()=>resolveFirst(response()));expect(host.textContent).not.toContain('SYN-A-PAIR-002');expect(state.sync).not.toHaveBeenCalled();
});
it('repeated landing visits never dispatch queued operations',async()=>{
  await render();await go('/opening/by-qr/'+other);await go(path);expect(state.sync).not.toHaveBeenCalled();expect(state.provider).not.toHaveBeenCalled();
});
it.each([response({...names,photos:['secret']}),response({},404),response({},429),response({},401,'text/html')])('fails closed without stale/private output for unavailable responses',async value=>{
  vi.mocked(fetch).mockResolvedValue(value as any);await render();expect(host.textContent).toContain('Opening information is unavailable');expect(host.textContent).not.toContain('secret');expect(host.querySelector('a')).toBeNull();expect(state.sync).not.toHaveBeenCalled();
});
it('rejects malformed tokens before any network access',async()=>{
  await expect(fetchPublicOpening('bad',new AbortController().signal)).rejects.toThrow('unavailable');expect(fetch).not.toHaveBeenCalled();
});
it.each(['/opening/by-qr/','/opening/by-qr/bad/extra','/OPENING/BY-QR/bad'])('keeps malformed QR route %s out of the worker and auth lifecycle',async route=>{
  await render(route);expect(host.textContent).toContain('Opening information is unavailable');expect(state.sync).not.toHaveBeenCalled();expect(state.provider).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
