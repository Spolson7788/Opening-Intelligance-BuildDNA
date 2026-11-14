import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({auth:null as any,loading:false,listener:null as any}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>state}));
vi.mock('../field-app/src/lib/sync',()=>({refreshPendingCount:vi.fn(),onSyncStateChange:(fn:any)=>{state.listener=fn;return ()=>{};}}));
vi.mock('react-router-dom',()=>({Link:({children,to,onClick,className}:any)=><a href={to} className={className} onClick={(event)=>{event.preventDefault();onClick?.(event);}}>{children}</a>,useNavigate:()=>vi.fn()}));
const records=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:async()=>state.auth,getSyncOperationsForPrincipal:()=>records.read(),getOpenConflictsForPrincipal:async()=>[],getOfflineMediaForPrincipal:async()=>[]}));
vi.mock('../field-app/src/lib/api',()=>({fetchCompanies:async()=>({companies:[]})}));
import {refreshPendingCount} from '../field-app/src/lib/sync';
import {SyncBadge} from '../field-app/src/components/SyncBadge';
import {AccountIdentity} from '../field-app/src/components/AccountIdentity';
import {syncIssueMessage} from '../field-app/src/lib/syncIssueMessage';
import {SyncIssuesPage} from '../field-app/src/pages/SyncIssuesPage';
let el:HTMLDivElement,root:ReturnType<typeof createRoot>;
const account=(id:string)=>({userId:id,organizationId:'org-'+id,email:id+'@example.invalid',token:'NEVER-DISPLAY'});
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);state.auth=account('A');state.loading=false;el=document.createElement('div');root=createRoot(el);});
afterEach(()=>{act(()=>root.unmount());vi.unstubAllGlobals();});
function render(){act(()=>root.render(<><AccountIdentity/><SyncBadge/></>));}
function emit(value:any){act(()=>state.listener({pending:0,failed:0,conflicts:0,syncing:false,checked:true,userId:'A',organizationId:'org-A',...value}));}
it('does not claim success before a checked principal; zero work is scoped',()=>{render();expect(el.textContent).toContain('Checking sync');emit({});expect(el.textContent).toContain('No pending changes for this account');expect(el.textContent).not.toContain('Synced');expect(el.textContent).not.toContain('NEVER-DISPLAY');});
it('hides old account and queue immediately on switch and rejects stale observations',()=>{render();emit({pending:7});expect(el.textContent).toContain('7 pending');state.auth=account('B');render();expect(el.textContent).not.toContain('A@example');expect(el.textContent).not.toContain('7 pending');expect(el.textContent).toContain('Checking sync');emit({pending:9});expect(el.textContent).not.toContain('9 pending');emit({userId:'B',organizationId:'org-B'});expect(el.textContent).toContain('No pending changes for this account');});
it('has explicit error, signed-out and auth-loading states',()=>{render();emit({checked:false,checkFailed:true});expect(el.textContent).toContain('Unable to check');const badge=el.querySelector('a.badge') as HTMLAnchorElement;expect(badge.getAttribute('href')).toBe('/sync-issues');vi.mocked(refreshPendingCount).mockClear();badge.click();expect(refreshPendingCount).toHaveBeenCalled();state.auth=null;render();expect(el.textContent).toContain('Sign in to check');expect(el.textContent).not.toContain('A@example');state.loading=true;render();expect(el.textContent).toContain('Checking sync');});
it('legacy sessions display current principal instead of another account email',()=>{state.auth={userId:'legacy',organizationId:'org'};render();expect(el.textContent).toContain('Account legacy');expect(el.textContent).not.toContain('Organization');});
it('explains recovery without exposing raw errors or relaxing authorization',()=>{expect(syncIssueMessage('auth_required')).toContain('will not retry automatically');const text=syncIssueMessage('auth_required','unexpected_response');expect(text).toContain('unexpected response');expect(text).not.toContain('unexpected_response');expect(syncIssueMessage('retry_wait','SECRET-response')).not.toContain('SECRET');expect(syncIssueMessage('permanent_failure','photo_unreadable')).toContain('could not be read');});
it('explains an unreadable local queue and retries without removing it',async()=>{
  records.read.mockRejectedValueOnce(new Error('idb unavailable'));
  await act(async()=>root.render(<SyncIssuesPage/>));
  expect(el.textContent).toContain('could not be read');
  expect(el.textContent).toContain('not removed');
  expect(el.textContent).not.toContain('idb unavailable');
  records.read.mockResolvedValueOnce([]);
  const retry=Array.from(el.querySelectorAll('button')).find(button=>button.textContent==='Retry');
  await act(async()=>retry!.click());
  expect(el.textContent).toContain('No synchronization issues');
});
it('shows the reason and discard for a permanently failed inspection',async()=>{
  records.read.mockResolvedValueOnce([{operationId:'insp',entityType:'inspection_event',state:'permanent_failure',createdAtLocal:new Date().toISOString(),lastErrorCode:'photo_unreadable'}]);
  await act(async()=>root.render(<SyncIssuesPage/>));
  expect(el.textContent).toContain('could not be read');
  expect(el.textContent).toContain('Discard this saved change');
  expect(el.textContent).not.toContain('Retry after authorization is restored');
});
it('review hides previous account items while the next account loads',async()=>{
  records.read.mockResolvedValueOnce([{operationId:'one',entityType:'photo',state:'auth_required',createdAtLocal:new Date().toISOString(),lastErrorCode:'unexpected_response'}]);
  await act(async()=>root.render(<SyncIssuesPage/>));
  expect(el.textContent).toContain('Retry after authorization is restored');
  let finish!:(v:any)=>void;records.read.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  state.auth=account('B');await act(async()=>root.render(<SyncIssuesPage/>));
  expect(el.textContent).toContain('Checking saved changes');expect(el.textContent).not.toContain('Retry after authorization');
  await act(async()=>finish([]));expect(el.textContent).toContain('No synchronization issues');
});
