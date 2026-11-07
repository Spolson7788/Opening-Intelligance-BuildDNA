import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({auth:null as any,loading:false,identityChecking:false,login:vi.fn(),logout:vi.fn(),finishStaffSignIn:vi.fn()}));
vi.mock('../field-app/src/lib/AuthContext',()=>{
  class StaffMfaRequired extends Error{mfaToken:string;enrollmentRequired:boolean;constructor(mfaToken:string,enrollmentRequired:boolean){super('mfa_required');this.mfaToken=mfaToken;this.enrollmentRequired=enrollmentRequired;}}
  return {useAuth:()=>state,StaffMfaRequired};
});
vi.mock('../field-app/src/lib/api',async(orig)=>{const actual=await orig<any>();return {...actual,enrollStaffMfa:vi.fn(),verifyStaffMfa:vi.fn()};});
import {LoginPage} from '../field-app/src/pages/LoginPage';
import {StaffMfaRequired} from '../field-app/src/lib/AuthContext';
import {enrollStaffMfa} from '../field-app/src/lib/api';
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
const account=(id='A')=>({userId:id,organizationId:'org-'+id,email:id+'@example.invalid',token:'synthetic-never-display'});
function Destination(){const l=useLocation();return <p>Destination {l.pathname}</p>;}
async function render(from:any='/opening/test'){await act(async()=>root.render(<MemoryRouter initialEntries={[{pathname:'/login',state:{from}}]}><Routes><Route path='/login' element={<LoginPage/>}/><Route path='*' element={<Destination/>}/></Routes></MemoryRouter>));}
const click=async(text:string)=>{const b=Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!;await act(async()=>b.click());};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);state.auth=null;state.loading=false;state.identityChecking=false;state.login.mockReset().mockResolvedValue(undefined);state.logout.mockReset();state.finishStaffSignIn.mockReset();vi.mocked(enrollStaffMfa).mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('shows the existing account without credential form or automatic navigation/auth calls',async()=>{
 state.auth=account();await render();expect(host.textContent).toContain('Already signed in');expect(host.textContent).toContain('A@example.invalid');expect(host.textContent).toContain('org-A');expect(host.querySelector('form')).toBeNull();expect(host.textContent).not.toContain(state.auth.token);expect(host.textContent).not.toContain('Destination');expect(state.login).not.toHaveBeenCalled();expect(state.logout).not.toHaveBeenCalled();
 await click('Continue with this account');expect(host.textContent).toContain('Destination /opening/test');expect(state.logout).not.toHaveBeenCalled();
});
it.each(['https://example.invalid','//example.invalid','/login','/opening/test?redirect=evil','/\\example.invalid'])('keeps unsafe return %s on the supported scan route',async(from)=>{
 state.auth=account();await render(from);await click('Continue with this account');expect(host.textContent).toContain('Destination /scan');
});
it('offers Scan without signing out or changing the principal',async()=>{state.auth=account();await render();await click('Go to Scan');expect(host.textContent).toContain('Destination /scan');expect(state.auth.userId).toBe('A');expect(state.logout).not.toHaveBeenCalled();});
it('hides stale identity and all credential controls during account reconciliation',async()=>{
 state.auth=account();state.identityChecking=true;await render();expect(host.textContent).toContain('Checking signed-in account');expect(host.textContent).not.toContain('A@example.invalid');expect(host.querySelector('form')).toBeNull();expect(host.querySelector('button')).toBeNull();
 state.auth=account('B');state.identityChecking=false;await render();expect(host.textContent).toContain('B@example.invalid');expect(host.textContent).not.toContain('A@example.invalid');
 state.auth=null;state.loading=true;await render();expect(host.querySelector('form')).toBeNull();state.loading=false;await render();expect(host.querySelector('form')).not.toBeNull();expect(host.textContent).not.toContain('B@example.invalid');
});
async function submitPassword(){
  (host.querySelector('#email') as HTMLInputElement).value='staff@example.invalid';
  (host.querySelector('#password') as HTMLInputElement).value='synthetic-test-only';
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
}
it('asks an enrolled staff account for a code and does not open the app',async()=>{
  state.login.mockRejectedValueOnce(new StaffMfaRequired('pending-token',false));
  await render();
  await submitPassword();
  expect(host.textContent).toContain('Authenticator code');
  expect(host.textContent).toContain('6-digit code');
  expect(host.textContent).not.toContain('Shown only once');
  expect(host.textContent).not.toContain('Destination');
  expect(enrollStaffMfa).not.toHaveBeenCalled();
});
it('shows the setup QR and recovery codes only while enrolling',async()=>{
  state.login.mockRejectedValueOnce(new StaffMfaRequired('pending-token',true));
  vi.mocked(enrollStaffMfa).mockResolvedValueOnce({otpauth_url:'otpauth://totp/example',secret:'SETUPKEY',qr_data_url:'data:image/png;base64,aaaa',recovery_codes:['ABCDE-FGHIJ'],warning:'These codes are shown only once.'});
  await render();
  await submitPassword();
  expect(host.textContent).toContain('Shown only once');
  expect(host.textContent).toContain('SETUPKEY');
  expect(host.textContent).toContain('ABCDE-FGHIJ');
  expect(host.querySelector('img')?.getAttribute('alt')).toBe('Authenticator setup QR code');
  const add = host.querySelector('a.mfa-add-app');
  expect(add?.textContent).toBe('Add to authenticator app');
  expect(add?.getAttribute('href')).toBe('otpauth://totp/example');
  expect(add?.getAttribute('target')).toBeNull();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await click('Copy setup key');
  expect(writeText).toHaveBeenCalledWith('SETUPKEY');
  expect(host.textContent).not.toContain('Destination');
});
it('preserves normal signed-out sign-in and its validated return route',async()=>{
 await render();(host.querySelector('#email') as HTMLInputElement).value='a@example.invalid';(host.querySelector('#password') as HTMLInputElement).value='synthetic-test-only';await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(state.login).toHaveBeenCalledWith('a@example.invalid','synthetic-test-only');expect(host.textContent).toContain('Destination /opening/test');expect(state.logout).not.toHaveBeenCalled();
});
