import React, {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {MemoryRouter, Route, Routes} from 'react-router-dom';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const session=vi.hoisted(()=>({auth:{userId:'user',organizationId:'org'}}));
vi.mock('../field-app/src/lib/api',()=>({fetchOpening:vi.fn()}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>({auth:session.auth})}));
vi.mock('../field-app/src/lib/sync',()=>({queueOpeningMutation:vi.fn()}));
vi.mock('../field-app/src/lib/db',()=>({updateCachedOpening:vi.fn()}));
vi.mock('../field-app/src/components/PhotoCapture',()=>({PhotoCapture:()=>null}));
import {fetchOpening} from '../field-app/src/lib/api';
import {queueOpeningMutation} from '../field-app/src/lib/sync';
import {OpeningStructurePage} from '../field-app/src/pages/OpeningStructurePage';
const opening={id:'pair',opening_configuration:'pair',frame:{id:'frame',revision:3,material:'Steel',condition:'good'},door_leaves:[{id:'active',leaf_role:'active',revision:4,material:'A',condition:'good'},{id:'inactive',leaf_role:'inactive',revision:7,material:'B',condition:'worn'}]};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.resetAllMocks();session.auth={userId:'user',organizationId:'org'};vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function mount(state?:any){await act(async()=>root.render(<MemoryRouter initialEntries={[{pathname:'/opening/pair/structure',state}]}><Routes><Route path='/opening/:id/structure' element={<OpeningStructurePage/>}/></Routes></MemoryRouter>));}
it('waits for an authorized opening on direct entry and preserves paired identity/revision',async()=>{
  let resolve:any;vi.mocked(fetchOpening).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  await mount();expect(host.textContent).toContain('Loading opening structure');expect(host.querySelector('input')).toBeNull();
  await act(async()=>resolve({opening,fromCache:false}));
  expect(host.textContent).toContain('active and inactive');
  const role=host.querySelector('#leaf-role') as HTMLSelectElement;
  await act(async()=>{role.value='inactive';role.dispatchEvent(new Event('change',{bubbles:true}));});
  expect((host.querySelector('#leaf-material') as HTMLInputElement).value).toBe('B');
  const save=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Save inactive leaf')!;
  await act(async()=>save.click());
  expect(queueOpeningMutation).toHaveBeenCalledWith('door_leaf','pair',expect.objectContaining({id:'inactive',expected_revision:7,leaf_role:'inactive'}),undefined,{userId:'user',organizationId:'org'});
});
it('does not trust stale navigation state or expose controls after access refusal',async()=>{
  vi.mocked(fetchOpening).mockRejectedValue(new Error('403 private details'));
  await mount({opening});expect(host.textContent).toContain('could not be loaded');
  expect(host.querySelector('input')).toBeNull();expect(host.textContent).not.toContain('private details');expect(queueOpeningMutation).not.toHaveBeenCalled();
});
it.each([{...opening,id:'other'}, {...opening,opening_configuration:undefined}])('fails closed for mismatched or incomplete records',async(record)=>{
  vi.mocked(fetchOpening).mockResolvedValue({opening:record,fromCache:false});await mount();expect(host.querySelector('input')).toBeNull();expect(host.textContent).toContain('could not be loaded');
});
it('uses the existing principal-scoped offline cache result without inventing a new structure',async()=>{
  vi.mocked(fetchOpening).mockResolvedValue({opening,fromCache:true});await mount();
  expect(host.textContent).toContain('active and inactive');expect((host.querySelector('#frame-material') as HTMLInputElement).value).toBe('Steel');
});
it('ignores an old principal response after an account switch',async()=>{
  let oldResponse:any;
  vi.mocked(fetchOpening).mockImplementationOnce(()=>new Promise(r=>{oldResponse=r;}));
  await mount();
  session.auth={userId:'other',organizationId:'other-org'};
  vi.mocked(fetchOpening).mockRejectedValueOnce(new Error('denied'));
  await mount();
  await act(async()=>oldResponse({opening,fromCache:false}));
  expect(host.textContent).toContain('could not be loaded');
  expect(host.querySelector('input')).toBeNull();expect(queueOpeningMutation).not.toHaveBeenCalled();
});
