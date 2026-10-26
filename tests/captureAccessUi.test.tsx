import React,{act} from 'react';
import {createRoot,Root} from 'react-dom/client';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({listener:(_:any)=>{},media:[] as any[],operations:[] as any[]}));
vi.mock('../field-app/src/lib/api',()=>({fetchOpening:vi.fn(),fetchOpeningByQr:vi.fn(),fetchOpeningByCode:vi.fn(),deletePhoto:vi.fn(),fetchPhotoAccessUrl:vi.fn()}));
vi.mock('../field-app/src/lib/db',()=>({
  getAllOfflineMedia:vi.fn(async()=>state.media),getSyncOperationsForOpening:vi.fn(async()=>state.operations),updateCachedOpening:vi.fn(),
  loadAuth:vi.fn(async()=>({userId:'a',organizationId:'ca'})),getAllSyncOperations:vi.fn(async()=>state.operations),
  saveMediaAndOperation:vi.fn(async(media,operation)=>{state.media.push(media);state.operations.push(operation);}),
}));
vi.mock('../field-app/src/lib/sync',()=>({onSyncStateChange:vi.fn(fn=>{state.listener=fn;return ()=>{};}),queueOpeningMutation:vi.fn(),checksumBlob:vi.fn(async()=> 'checksum'),dependencyIdsForOperation:()=>[],flushOutbox:vi.fn(async()=>{}),getOrCreateDeviceId:vi.fn(async()=> 'device')}));
vi.mock('../field-app/src/lib/photoPreparation',()=>({prepareImageForUpload:vi.fn(async(file)=>({blob:file,contentType:'image/png',withinLimit:true,reduced:false})),reducedFilename:(s:string)=>s}));
vi.mock('../field-app/src/components/SyncBadge',()=>({SyncBadge:()=> <span>Synced</span>}));
import {fetchOpening} from '../field-app/src/lib/api';
import {saveMediaAndOperation} from '../field-app/src/lib/db';
import {flushOutbox} from '../field-app/src/lib/sync';
import {OpeningDetailPage} from '../field-app/src/pages/OpeningDetailPage';
const opening={id:'test',opening_code:'DEMO',opening_type:'door',opening_configuration:'single',photos:[],hardware_components:[{id:'closer',component_type:'closer',manufacturer:'Cal-Royal',model_number:'CR441',tracker_id:'TRACK'},{id:'other-closer',component_type:'closer',manufacturer:'Cal-Royal',model_number:'CR441',tracker_id:'OTHER'}],service_events:[],door_leaves:[]};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{
  vi.clearAllMocks();state.media=[];state.operations=[];state.listener=()=>{};
  // A failed test must not leak an unconsumed one-shot response into the next test.
  vi.mocked(fetchOpening).mockReset();
  vi.mocked(saveMediaAndOperation).mockReset().mockImplementation(async(media,operation)=>{state.media.push(media);state.operations.push(operation);});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  URL.createObjectURL=vi.fn(()=> 'blob:mock');URL.revokeObjectURL=vi.fn();
  vi.mocked(fetchOpening).mockResolvedValue({opening,fromCache:false});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function mount(){await act(async()=>root.render(<MemoryRouter initialEntries={['/field/opening/test']}><Routes><Route path='/field/opening/:id' element={<OpeningDetailPage/>}/></Routes></MemoryRouter>));}
// Match a completed sync cycle; an idle count refresh must not fetch the opening.
async function completeSync(){const reads=vi.mocked(fetchOpening).mock.calls.length;await act(async()=>state.listener({syncing:true}));await act(async()=>state.listener({syncing:false}));expect(fetchOpening).toHaveBeenCalledTimes(reads+1);}
function input(){return host.querySelector('#photo-input-test-hardware_component-closer') as HTMLInputElement;}
async function select(){const node=input();Object.defineProperty(node,'files',{configurable:true,value:[new File(['synthetic'],'test.png',{type:'image/png'})]});await act(async()=>node.dispatchEvent(new Event('change',{bubbles:true})));}
it('keeps the same picker node throughout a pending and completed background refresh',async()=>{
  await mount();const node=input();let resolve:any;
  vi.mocked(fetchOpening).mockImplementationOnce(()=>new Promise(r=>{resolve=r}));
  await completeSync();expect(input()).toBe(node);
  await act(async()=>resolve({opening:{...opening,health_score:90},fromCache:false}));expect(input()).toBe(node);
});
it('keeps a save in progress mounted during refresh and commits exactly once',async()=>{
  await mount();let finish:any;
  vi.mocked(saveMediaAndOperation).mockImplementationOnce((media,op)=>new Promise<void>(r=>{finish=()=>{state.media.push(media);state.operations.push(op);r();}}));
  const node=input();await select();expect(node.disabled).toBe(true);
  await completeSync();expect(input()).toBe(node);
  await act(async()=>finish());expect(saveMediaAndOperation).toHaveBeenCalledTimes(1);expect(state.media).toHaveLength(1);expect(state.operations).toHaveLength(1);
});
it('shows sanitized local storage failure and does not upload or create a queue item',async()=>{
  await mount();vi.mocked(saveMediaAndOperation).mockRejectedValueOnce(new Error('SECRET database details'));
  await select();expect(host.textContent).toContain('No new photo was queued');expect(host.textContent).not.toContain('SECRET');expect(flushOutbox).not.toHaveBeenCalled();expect(state.media).toHaveLength(0);
});
it('retains the queued photo and picker across site-gate failure and access recheck without recapture',async()=>{
  await mount();await select();const node=input();const photoId=state.media[0].photoId;
  vi.mocked(fetchOpening).mockRejectedValueOnce(Object.assign(new Error('site_access_required'),{status:401}));
  await completeSync();expect(input()).toBe(node);
  expect(host.textContent).toContain('Renew access to this private preview');
  const link=host.querySelector('a[href^="https://app.netlify.com/edge-access"]')!;expect(link.getAttribute('target')).toBe('_blank');
  const check=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Check access again')!;
  await act(async()=>check.click());expect(state.media[0].photoId).toBe(photoId);expect(state.media).toHaveLength(1);expect(state.operations).toHaveLength(1);expect(saveMediaAndOperation).toHaveBeenCalledTimes(1);expect(input()).toBe(node);
});
it('does not retain opening controls on a genuine app authentication refusal',async()=>{
  await mount();vi.mocked(fetchOpening).mockRejectedValueOnce(Object.assign(new Error('invalid_token'),{status:401}));
  await completeSync();expect(input()).toBeNull();expect(host.textContent).toContain('Sign-in required');
});
it('keeps the picker mounted on a background network failure',async()=>{
  await mount();const node=input();vi.mocked(fetchOpening).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await completeSync();expect(input()).toBe(node);expect(host.textContent).toContain('connection or service is unavailable');
});


it.each([['opening','test','opening'],['hardware_component','closer','closer / Cal-Royal / CR441 / TRACK'],['hardware_component','other-closer','closer / Cal-Royal / CR441 / OTHER']])('labels and queues the %s control with its exact target',async(type,id,label)=>{
  await mount();
  const node=host.querySelector('#photo-input-test-'+type+'-'+id) as HTMLInputElement;
  expect(node.getAttribute('aria-label')).toBe('Choose photo for '+label);
  expect(host.querySelector('label[for="'+node.id+'"]')!.textContent).toContain('Add photo to '+label);
  Object.defineProperty(node,'files',{configurable:true,value:[new File(['synthetic'],'target.png',{type:'image/png'})]});
  await act(async()=>node.dispatchEvent(new Event('change',{bubbles:true})));
  expect(saveMediaAndOperation).toHaveBeenCalledTimes(1);
  expect(state.media[0]).toMatchObject({targetType:type,targetId:id});
  expect(state.operations[0].payload).toMatchObject({target_type:type,target_id:id});
  const caption=Array.from(host.querySelectorAll('p')).find(p=>p.textContent?.startsWith('Target:'));
  expect(caption?.textContent).toContain(type==='opening'?'Opening photograph':'CR441');
  if(type!=='opening')expect(caption?.textContent).toContain(id==='closer'?'TRACK':'OTHER');
});
