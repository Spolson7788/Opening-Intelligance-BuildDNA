import {beforeEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({pauseAt:'reserve',dispatches:[] as string[],saved:[] as any[],receipts:[] as any[]}));
const db=vi.hoisted(()=>({loadAuth:vi.fn(),getSyncOperationsForPrincipal:vi.fn(),claimSyncOperation:vi.fn(),getOfflineMedia:vi.fn(),putSyncOperation:vi.fn(),putSyncReceipt:vi.fn()}));
vi.mock('../field-app/src/lib/db',()=>db);
vi.mock('../field-app/src/lib/api',async importOriginal=>{
  const original=await importOriginal<typeof import('../field-app/src/lib/api')>();
  const gate=await import('../field-app/src/lib/syncNavigation');
  return {...original,
    reserveOfflinePhoto:async()=>{gate.assertSyncDispatchAllowed();state.dispatches.push('reserve');if(state.pauseAt==='reserve')gate.setSyncReadOnly(true);return {status:'reserved',upload_url:'synthetic-url'};},
    uploadPrivatePhoto:async()=>{state.dispatches.push('put');if(state.pauseAt==='put')gate.setSyncReadOnly(true);},
    confirmOfflinePhoto:async()=>{gate.assertSyncDispatchAllowed();state.dispatches.push('confirm');if(state.pauseAt==='confirm')gate.setSyncReadOnly(true);return {operation_id:'op',entity_id:'photo',entity_type:'photo',opening_id:'opening',organization_id:'org',resulting_server_revision:1};},
  };
});
import {flushVersionedOperations} from '../field-app/src/lib/sync';
import {setSyncReadOnly} from '../field-app/src/lib/syncNavigation';
const op={operationId:'op',operationType:'create',entityType:'photo',entityId:'photo',openingId:'opening',organizationId:'org',actorUserId:'user',deviceId:'device',state:'queued',dependencyOperationIds:[],payload:{},attemptCount:0,createdAtLocal:'2026-01-01T00:00:00Z'};
beforeEach(()=>{
  setSyncReadOnly(false);state.dispatches=[];state.saved=[];state.receipts=[];
  db.loadAuth.mockResolvedValue({userId:'user',organizationId:'org'});
  db.getSyncOperationsForPrincipal.mockResolvedValue([op]);db.claimSyncOperation.mockResolvedValue({...op,state:'in_flight'});
  db.getOfflineMedia.mockResolvedValue({photoId:'photo',openingId:'opening',targetType:'component',targetId:'closer',contentType:'image/png',byteSize:100,blob:new Blob(['synthetic']),sha256Checksum:'fake'});
  db.putSyncOperation.mockImplementation(async value=>{state.saved.push(value);});db.putSyncReceipt.mockImplementation(async value=>{state.receipts.push(value);});
});
it.each(['reserve','put'])('retains the same operation and stops later photo steps after %s',async at=>{
  state.pauseAt=at;await flushVersionedOperations();
  expect(state.dispatches).toEqual(at==='reserve'?['reserve']:['reserve','put']);expect(state.receipts).toEqual([]);
  expect(state.saved).toHaveLength(1);expect(state.saved[0]).toMatchObject({operationId:'op',entityId:'photo',state:'queued',attemptCount:0});
});
it('records confirmation already received before pause and does not send another request',async()=>{
  state.pauseAt='confirm';await flushVersionedOperations();expect(state.dispatches).toEqual(['reserve','put','confirm']);expect(state.receipts).toHaveLength(1);expect(state.saved).toEqual([]);
});
