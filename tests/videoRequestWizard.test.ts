// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement,act} from '../field-app/node_modules/react';
import {createRoot} from '../field-app/node_modules/react-dom/client';
const state=vi.hoisted(()=>({id:'opening-a',query:new URLSearchParams(),pending:[] as any[],auth:{userId:'user-a',organizationId:'org-a',role:'technician'},context:vi.fn()}));
vi.mock('../field-app/node_modules/react-router-dom/dist/index.js',()=>({useParams:()=>({id:state.id}),useSearchParams:()=>[state.query],Link:({children}:any)=>children}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>({auth:state.auth})}));
vi.mock('../field-app/src/lib/api',()=>({fetchServiceRequestContext:state.context,isClientPrincipalChange:()=>false}));
vi.mock('../field-app/src/lib/db',()=>({getOfflineSetting:vi.fn(),putOfflineSetting:vi.fn(),loadAuth:async()=>state.auth,getSyncOperationsForPrincipal:async()=>state.pending}));
vi.mock('../field-app/src/lib/sync',()=>({queueOpeningMutation:vi.fn(),onSyncStateChange:(cb:any)=>{cb();return()=>{};}}));
vi.mock('../field-app/src/components/SyncBadge',()=>({SyncBadge:()=>null}));
import {ServiceRequestPage} from '../field-app/src/pages/ServiceRequestPage';
let root:ReturnType<typeof createRoot>,host:HTMLDivElement;
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;state.id='opening-a';state.pending=[];
 state.context.mockImplementation(async id=>({opening_id:id,opening_code:id,status:'active',providers:[{id:'p',name:'Provider'}],frame:null,door_leaves:[],hardware_components:[],photos:[],requests:[]}));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();});
it('resumes a previously saved pending request on remount instead of presenting another submit form',async()=>{
 state.pending=[{operationId:'retained',openingId:'opening-a',entityType:'service_request',state:'queued'}];
 await act(async()=>root.render(createElement(ServiceRequestPage)));
 expect(host.textContent).toContain('pending synchronization');expect(host.querySelector('form')).toBeNull();
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Start a separate request')!.click());
 expect(host.querySelector('form')).not.toBeNull();expect(state.pending[0].operationId).toBe('retained');
});
it('replaces all form state when the opening route changes',async()=>{
 await act(async()=>root.render(createElement(ServiceRequestPage)));
 const input=host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
 await act(async()=>input.click());expect(input.checked).toBe(true);
 let resolve:any;state.context.mockReturnValueOnce(new Promise(r=>{resolve=r;}));state.id='opening-b';
 await act(async()=>root.render(createElement(ServiceRequestPage)));
 expect(host.querySelector('form')).toBeNull();
 await act(async()=>resolve({opening_id:'opening-b',opening_code:'opening-b',status:'active',providers:[],frame:null,door_leaves:[],hardware_components:[],photos:[],requests:[]}));
 expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
 expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
});
