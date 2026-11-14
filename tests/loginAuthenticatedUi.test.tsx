import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({auth:null as any,loading:false,identityChecking:false,login:vi.fn(),logout:vi.fn(),finishStaffSignIn:vi.fn()}));
vi.mock('../field-app/src/lib/AuthContext',()=>{
  class StaffMfaRequired extends Error{mfaToken:string;constructor(mfaToken:string){super('mfa_required');this.mfaToken=mfaToken;}}
  return {useAuth:()=>state,StaffMfaRequired};
});
vi.mock('../field-app/src/lib/api',async(orig)=>{const actual=await orig<any>();return {...actual,resendStaffSignInCode:vi.fn(),verifyStaffMfa:vi.fn()};});
import {LoginPage} from '../field-app/src/pages/LoginPage';
import {StaffMfaRequired} from '../field-app/src/lib/AuthContext';
import {resendStaffSignInCode,verifyStaffMfa} from '../field-app/src/lib/api';
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
const account=(id='A')=>({userId:id,organizationId:'org-'+id,email:id+'@example.invalid',token:'synthetic-never-display'});
function Destination(){const l=useLocation();return <p>Destination {l.pathname}</p>;}
async function render(from:any='/opening/test'){await act(async()=>root.render(<MemoryRouter initialEntries={[{pathname:'/login',state:{from}}]}><Routes><Route path='/login' element={<LoginPage/>}/><Route path='*' element={<Destination/>}/></Routes></MemoryRouter>));}
const click=async(text:string)=>{const b=Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!;await act(async()=>b.click());};
const futureToken=()=>{const part=(value:object)=>btoa(JSON.stringify(value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');return `${part({alg:'none'})}.${part({exp:Math.floor(Date.now()/1000)+600})}.sig`;};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);sessionStorage.clear();state.auth=null;state.loading=false;state.identityChecking=false;state.login.mockReset().mockResolvedValue(undefined);state.logout.mockReset();state.finishStaffSignIn.mockReset();vi.mocked(resendStaffSignInCode).mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('shows the existing account without credential form or automatic navigation/auth calls',async()=>{
 state.auth=account();await render();expect(host.textContent).toContain('Already signed in');expect(host.textContent).toContain('A@example.invalid');expect(host.textContent).not.toContain('org-A');expect(host.querySelector('form')).toBeNull();expect(host.textContent).not.toContain(state.auth.token);expect(host.textContent).not.toContain('Destination');expect(state.login).not.toHaveBeenCalled();expect(state.logout).not.toHaveBeenCalled();
 await click('Continue with this account');expect(host.textContent).toContain('Destination /opening/test');expect(state.logout).not.toHaveBeenCalled();
});
it.each(['https://example.invalid','//example.invalid','/login','/opening/test?redirect=evil','/\\example.invalid'])('sends an unsafe return %s to the location chooser before Scan',async(from)=>{
 state.auth=account();await render(from);await click('Continue with this account');expect(host.textContent).toContain('Destination /choose-location');
});
it('keeps an explicit door target',async()=>{
 const door='/opening/by-qr/11111111-1111-4111-8111-111111111111/details';
 state.auth=account();await render(door);await click('Continue with this account');expect(host.textContent).toContain('Destination '+door);
});
it('returns a confirmed session to Scan',async()=>{
 state.auth=account();sessionStorage.setItem('location-confirmed:A:org-A','facility-a');await render('/scan');await click('Go to Scan');expect(host.textContent).toContain('Destination /scan');
});
it('offers the location step without signing out or changing the principal',async()=>{state.auth=account();await render();await click('Go to Scan');expect(host.textContent).toContain('Destination /choose-location');expect(state.auth.userId).toBe('A');expect(state.logout).not.toHaveBeenCalled();});
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
it('keeps the emailed code screen after a reload and does not send another code',async()=>{
  state.login.mockRejectedValueOnce(new StaffMfaRequired(futureToken()));
  await render();
  await submitPassword();
  expect(host.textContent).toContain('Email sign-in code');
  expect(host.textContent).toContain('staff@example.invalid');
  expect(host.textContent).toContain('Resend code');
  expect(host.textContent).not.toContain('Destination');
  expect(resendStaffSignInCode).not.toHaveBeenCalled();
  act(()=>root.unmount());
  root=createRoot(host);
  await render();
  expect(host.textContent).toContain('Email sign-in code');
  expect(host.textContent).toContain('staff@example.invalid');
  expect(state.login).toHaveBeenCalledTimes(1);
  expect(resendStaffSignInCode).not.toHaveBeenCalled();
});
it('opens the location chooser after the email code, and a door link skips it',async()=>{
 state.login.mockRejectedValueOnce(new StaffMfaRequired(futureToken()));
 vi.mocked(verifyStaffMfa).mockResolvedValue({token:'synthetic-token'});
 await render('/scan');
 await submitPassword();
 const input=host.querySelector('#mfa-code') as HTMLInputElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'123456');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Destination /choose-location');
 expect(state.finishStaffSignIn).toHaveBeenCalled();
});
it('keeps a door link after the email code',async()=>{
 const door='/opening/by-qr/11111111-1111-4111-8111-111111111111/details';
 state.login.mockRejectedValueOnce(new StaffMfaRequired(futureToken()));
 vi.mocked(verifyStaffMfa).mockResolvedValue({token:'synthetic-token'});
 await render(door);await submitPassword();
 const input=host.querySelector('#mfa-code') as HTMLInputElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'654321');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Destination '+door);
});
it('preserves normal signed-out sign-in and its validated return route',async()=>{
 await render();(host.querySelector('#email') as HTMLInputElement).value='a@example.invalid';(host.querySelector('#password') as HTMLInputElement).value='synthetic-test-only';await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(state.login).toHaveBeenCalledWith('a@example.invalid','synthetic-test-only');expect(host.textContent).toContain('Destination /opening/test');expect(state.logout).not.toHaveBeenCalled();
});
