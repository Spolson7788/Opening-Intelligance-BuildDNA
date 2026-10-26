import {it,expect,vi} from 'vitest';
const db=vi.hoisted(()=>({auth:{userId:'A',organizationId:'org-A'} as any,read:vi.fn()}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:async()=>db.auth,getSyncOperationsForPrincipal:(...args:any[])=>db.read(...args)}));
import {refreshPendingCount,onSyncStateChange,flushOutbox} from '../field-app/src/lib/sync';
it('never publishes A queue after account changes during the read',async()=>{
  let finish!:(v:any)=>void;db.auth={userId:'A',organizationId:'org-A'};
  db.read.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  let state:any;const stop=onSyncStateChange(s=>{state=s;});
  const pending=refreshPendingCount();await vi.waitFor(()=>expect(finish).toBeDefined());
  db.auth={userId:'B',organizationId:'org-B'};finish([{state:'queued'}]);await pending;
  expect(state.checked).toBe(false);expect(state.pending).toBe(0);
  db.read.mockResolvedValueOnce([]);await refreshPendingCount();expect(state).toMatchObject({checked:true,userId:'B',pending:0});stop();
});
it('storage failure clears counts and reports unavailable, not successful sync',async()=>{
  db.read.mockRejectedValueOnce(new Error('PRIVATE-DETAIL'));let state:any;const stop=onSyncStateChange(s=>{state=s;});
  await refreshPendingCount();expect(state).toMatchObject({checked:false,checkFailed:true,pending:0});expect(JSON.stringify(state)).not.toContain('PRIVATE-DETAIL');stop();
});
it('failed status reads cannot release the active flush lock',async()=>{
  vi.stubGlobal('navigator',{onLine:true});
  let finish!:(v:any)=>void;db.read.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  const running=flushOutbox();await vi.waitFor(()=>expect(finish).toBeDefined());
  db.read.mockRejectedValueOnce(new Error('local read failed'));
  await refreshPendingCount();const before=db.read.mock.calls.length;
  await flushOutbox();expect(db.read.mock.calls.length).toBe(before);
  db.read.mockResolvedValue([]);finish([]);await running;vi.unstubAllGlobals();
});
