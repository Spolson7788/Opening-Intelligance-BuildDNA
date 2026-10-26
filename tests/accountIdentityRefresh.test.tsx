import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const data=vi.hoisted(()=>({stored:null as any,read:vi.fn()}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:()=>data.read(),clearAuth:vi.fn()}));
vi.mock('../field-app/src/lib/api',()=>({login:vi.fn(),decodeTokenPayload:vi.fn()}));
vi.mock('../field-app/src/lib/freshSignIn',()=>({recordFreshSignIn:vi.fn()}));
import {AuthProvider,useAuth} from '../field-app/src/lib/AuthContext';
import {AccountIdentity} from '../field-app/src/components/AccountIdentity';
import {AccountScope} from '../field-app/src/components/AccountScope';
import {recordFreshSignIn} from '../field-app/src/lib/freshSignIn';
let el:HTMLDivElement,root:ReturnType<typeof createRoot>;
const account=(id:string)=>({userId:id,organizationId:'org-'+id,email:id+'@example.invalid',role:'admin',token:'PRIVATE'});
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data.stored=account('A');data.read.mockReset().mockImplementation(async()=>data.stored);el=document.createElement('div');root=createRoot(el);});
afterEach(()=>{act(()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();});
it('reconciles another tab account change and sign-out without replaying sign-in recovery',async()=>{
  await act(async()=>root.render(<AuthProvider><AccountIdentity/></AuthProvider>));expect(el.textContent).toContain('A@example');
  data.stored=account('B');await act(async()=>vi.advanceTimersByTimeAsync(1500));
  expect(el.textContent).toContain('B@example');expect(el.textContent).not.toContain('A@example');expect(el.textContent).not.toContain('PRIVATE');
  data.stored=null;await act(async()=>{window.dispatchEvent(new Event('focus'));});expect(el.textContent).toBe('');expect(recordFreshSignIn).not.toHaveBeenCalled();
});
it('invalidates display on focus and ignores late stale reads',async()=>{
  await act(async()=>root.render(<AuthProvider><AccountIdentity/></AuthProvider>));
  let finish!:(v:any)=>void;data.read.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  await act(async()=>{window.dispatchEvent(new Event('focus'));});expect(el.textContent).toBe('');
  data.stored=account('B');await act(async()=>vi.advanceTimersByTimeAsync(1500));
  await act(async()=>finish(account('A')));expect(el.textContent).toContain('B@example');expect(el.textContent).not.toContain('A@example');
});
it('focus and transient identity-read failure do not unmount a protected draft',async()=>{
  let mounts=0;
  function Draft(){const {auth}=useAuth();const [text]=React.useState(()=>{mounts++;return 'unsaved draft '+auth?.userId;});return <p>{text}</p>;}
  function Protected(){const {auth,loading}=useAuth();return loading||!auth?null:<AccountScope><Draft/></AccountScope>;}
  await act(async()=>root.render(<AuthProvider><AccountIdentity/><Protected/></AuthProvider>));
  data.read.mockRejectedValueOnce(new Error('read failed'));
  await act(async()=>{window.dispatchEvent(new Event('focus'));});
  expect(el.textContent).toContain('unsaved draft');expect(el.textContent).not.toContain('A@example');expect(mounts).toBe(1);
  await act(async()=>vi.advanceTimersByTimeAsync(1500));expect(el.textContent).toContain('A@example');expect(mounts).toBe(1);
  data.stored=account('B');await act(async()=>vi.advanceTimersByTimeAsync(1500));
  expect(mounts).toBe(2);expect(el.textContent).toContain('unsaved draft B');expect(el.textContent).not.toContain('unsaved draft A');
});
