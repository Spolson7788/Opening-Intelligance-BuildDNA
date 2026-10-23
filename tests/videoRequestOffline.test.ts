import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {closeFieldAppDb,saveAuth,getAllSyncOperations,putSyncOperation} from '../field-app/src/lib/db';
import {queueOpeningMutation,flushVersionedOperations} from '../field-app/src/lib/sync';
import {editHardwareComponent,PrincipalChangedError} from '../field-app/src/lib/api';
const a={userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',organizationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token:'a',role:'technician'};
const b={...a,userId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',token:'b'};
const opening='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const payload={symptom:'Will not latch',impact:'',priority:'normal',provider_organization_id:a.organizationId,uncertain_target:true,targets:[],photo_ids:[]};
beforeEach(async()=>{await closeFieldAppDb();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('navigator',{onLine:false});await saveAuth(a);});
afterEach(async()=>{await closeFieldAppDb();vi.unstubAllGlobals();});
it('binds a retained form to its original account before PATCH or queue writes',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await saveAuth(b);
 await expect(editHardwareComponent(opening,{expected_revision:1},a)).rejects.toBeInstanceOf(PrincipalChangedError);
 await expect(queueOpeningMutation('opening_frame',opening,{condition:'good'},undefined,a)).rejects.toBeInstanceOf(PrincipalChangedError);
 await expect(queueOpeningMutation('service_request',opening,payload,undefined,a)).rejects.toBeInstanceOf(PrincipalChangedError);
 expect(fetch).not.toHaveBeenCalled();expect(await getAllSyncOperations()).toEqual([]);
});
it('retains one offline request and its identity across account switch and lost response',async()=>{
 const id=await queueOpeningMutation('service_request',opening,payload,undefined,a);
 expect((await getAllSyncOperations())[0]).toMatchObject({state:'queued',entityType:'service_request',actorUserId:a.userId});
 await expect(queueOpeningMutation('service_request',opening,{...payload,symptom:'Changed'},id,a)).rejects.toThrow('request_retry_changed');
 let calls=0;const accepted=new Map();
 vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
  expect(String(url)).toContain('/service-requests');expect(options.headers.Authorization).toBe('Bearer a');calls++;
  const body=JSON.parse(options.body);expect(body.operation_id).toBe(id);
  if(!accepted.has(id))accepted.set(id,{operation_id:id,entity_id:body.entity_id,entity_type:'service_request',opening_id:opening,organization_id:a.organizationId,resulting_server_revision:1,normalized_record_hash:'hash',server_accepted_at:new Date().toISOString()});
  if(calls===1)throw new TypeError('Response lost');
  return new Response(JSON.stringify(accepted.get(id)),{status:200,headers:{'content-type':'application/json'}});
 }));
 await saveAuth(b);await flushVersionedOperations();expect(calls).toBe(0);
 await saveAuth(a);await flushVersionedOperations();
 const pending=(await getAllSyncOperations())[0];expect(pending.state).toBe('retry_wait');
 await putSyncOperation({...pending,nextAttemptAt:new Date(0).toISOString()});await flushVersionedOperations();await flushVersionedOperations();
 expect(calls).toBe(2);expect(accepted.size).toBe(1);expect((await getAllSyncOperations())[0].state).toBe('verified');
});
it('does not overwrite competing payloads for the same local request identity',async()=>{
 const id=crypto.randomUUID();
 const result=await Promise.allSettled([queueOpeningMutation('service_request',opening,payload,id,a),queueOpeningMutation('service_request',opening,{...payload,symptom:'Different'},id,a)]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(await getAllSyncOperations()).toHaveLength(1);
});
