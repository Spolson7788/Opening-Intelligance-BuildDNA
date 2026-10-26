import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {MemoryRouter,Routes,Route,Navigate} from 'react-router-dom';
const data=vi.hoisted(()=>({stored:{userId:'A',organizationId:'org-A',role:'admin',token:'FAKE'} as any,clear:vi.fn(),logout:null as any}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:async()=>data.stored,clearAuth:()=>data.clear()}));
vi.mock('../field-app/src/lib/api',()=>({login:vi.fn(),decodeTokenPayload:vi.fn(),fetchLabelConfig:async()=>({field_base:''})}));
vi.mock('../field-app/src/lib/freshSignIn',()=>({recordFreshSignIn:vi.fn()}));
vi.mock('../field-app/src/components/SyncBadge',()=>({SyncBadge:()=>null}));
vi.mock('html5-qrcode',()=>({Html5Qrcode:class {start(){return Promise.resolve();}stop(){return Promise.resolve();}}}));
import {AuthProvider,useAuth} from '../field-app/src/lib/AuthContext';
import {ScanPage} from '../field-app/src/pages/ScanPage';
import {AccountIdentity} from '../field-app/src/components/AccountIdentity';
let el:HTMLDivElement,root:ReturnType<typeof createRoot>;
function Protected(){const a=useAuth();data.logout=a.logout;if(a.loading)return null;return a.auth?<ScanPage/>:<Navigate to='/login' replace/>;}
async function render(){await act(async()=>root.render(<AuthProvider><MemoryRouter initialEntries={['/scan']}><AccountIdentity/><Routes><Route path='/scan' element={<Protected/>}/><Route path='/login' element={<p>LOGIN FORM</p>}/></Routes></MemoryRouter></AuthProvider>));}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data.stored={userId:'A',organizationId:'org-A',role:'admin',token:'FAKE'};data.clear.mockReset();el=document.createElement('div');root=createRoot(el);});
afterEach(()=>{act(()=>root.unmount());vi.unstubAllGlobals();});
it('actual Scan Sign Out button invokes local clear and redirects on success',async()=>{data.clear.mockImplementation(async()=>{data.stored=null;});await render();const b=Array.from(el.querySelectorAll('button')).find(b=>b.textContent==='Sign Out')!;expect(b.disabled).toBe(false);expect(b.closest('form')).toBeNull();await act(async()=>b.click());expect(data.clear).toHaveBeenCalledTimes(1);expect(el.textContent).toContain('LOGIN FORM');expect(el.textContent).not.toContain('Account A');});
it('rejected local deletion retains A and shows only a fixed safe error',async()=>{data.clear.mockRejectedValue(new DOMException('synthetic deletion refusal','AbortError'));await render();let name='';await act(async()=>{try{await data.logout();}catch(e){name=(e as Error).name;}});expect(name).toBe('');expect(el.textContent).toContain('Account A');expect(el.textContent).toContain('Sign Out');expect(el.textContent).not.toContain('LOGIN FORM');expect(el.querySelector('[role="alert"]')?.textContent).toContain('Sign-out could not be completed');expect(el.textContent).not.toContain('synthetic deletion refusal');});
it('pending deletion shows progress and prevents duplicate clicks until completion',async()=>{let finish!:()=>void;data.clear.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));await render();let pending:Promise<void>;await act(async()=>{pending=data.logout();});expect(el.textContent).toContain('Signing out');expect(el.querySelector('[role="status"]')).not.toBeNull();const b=Array.from(el.querySelectorAll('button')).find(b=>b.textContent==='Signing out…')!;expect(b.disabled).toBe(true);await act(async()=>{b.click();await data.logout();});expect(data.clear).toHaveBeenCalledTimes(1);await act(async()=>{data.stored=null;finish();await pending;});expect(el.textContent).toContain('LOGIN FORM');});
