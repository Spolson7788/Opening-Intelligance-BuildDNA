import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({auth:null as any,stored:null as any,read:vi.fn(),save:vi.fn()}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>({auth:state.auth})}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:async()=>state.stored}));
vi.mock('../field-app/src/lib/api',()=>({fetchConditionHistory:state.read,saveConditionObservation:state.save}));
import {ConditionHistoryPanel} from '../field-app/src/components/ConditionHistoryPanel';
const target=(id:string,role:string,type='component')=>({target:{type,id},label:`Closer — ${role} leaf — Synthetic`,tracker_id:`tracker-${id}`,lifecycle_state:'active'});
const unknown={certainty:'unknown',precision:'unknown',year:null,month:null,day:null};
const observation=(id:string='old')=>({id,target:{type:'component',id:'inactive'},condition:'worn',observed_date:{certainty:'estimated',precision:'month',year:2020,month:3,day:null},source_reference:'Historic maintenance log',note:'Recorded evidence',correction_of:null,correction_reason:'',recorded_by_user_id:'assessor-a',recorded_at:'2026-10-26T10:00:00Z',is_current:true,target_snapshot:target('inactive','inactive')});
const snapshot=()=>({opening_id:'opening-a',opening_code:'SYN-A',revision:7,status:'active',targets:[target('active','active'),target('inactive','inactive'),{...target('retired','active'),lifecycle_state:'retired'}, {target:{type:'frame',id:'frame'},label:'Frame',tracker_id:null}],observations:[observation()]});
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.useFakeTimers();state.auth={userId:'a',organizationId:'org-a',role:'admin'};state.stored=state.auth;state.read.mockReset().mockResolvedValue(snapshot());state.save.mockReset().mockResolvedValue({});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
const render=()=>act(async()=>root.render(<ConditionHistoryPanel openingId="opening-a"/>));
function control(text:string){return [...host.querySelectorAll('label')].find(e=>e.firstChild?.textContent===text)!.querySelector('input,select,textarea') as HTMLInputElement|HTMLSelectElement;}
async function change(text:string,value:string){await act(async()=>{const e=control(text);const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
const submit=()=>act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
it('shows entered precision, exact attribution, recorded assessor and nonprojection caveat',async()=>{
 await render();expect(host.textContent).toContain('2020-03 (estimated, month precision)');expect(host.textContent).not.toContain('2020-03-01');expect(host.textContent).toContain('tracker-inactive');expect(host.textContent).toContain('assessor-a');expect(host.textContent).toContain('Recorded observations do not change current assessment');expect(host.textContent).toContain('Uncorrected observation');
});
it('records an exact inactive target with unknown observed date and no inferred assessment',async()=>{
 await render();await change('Observed target','component:inactive');await change('Evidence source reference','Synthetic source');await submit();expect(state.save).toHaveBeenCalledTimes(1);const c=state.save.mock.calls[0][0];expect(c.expected_revision).toBe(7);expect(c.payload).toMatchObject({target:{type:'component',id:'inactive'},condition:'unverified',observed_date:unknown,source_reference:'Synthetic source',correction_of:null});expect(host.textContent).toContain('current assessment are unchanged');
});
it('appends correction to exact fixed target and preserves original evidence',async()=>{
 await render();await change('New observation or correction','old');expect(control('Observed target').disabled).toBe(true);expect(host.textContent).toContain('Correction target as originally recorded: Closer — inactive leaf');await change('Observed condition','good');await change('Correction reason','Corrected transcription');await submit();expect(state.save.mock.calls[0][0].payload).toMatchObject({target:{type:'component',id:'inactive'},condition:'good',correction_of:'old',correction_reason:'Corrected transcription',observed_date:observation().observed_date});expect(host.textContent).toContain('Historic maintenance log');
});
it('freezes uncertain submission and retries the identical operation only on explicit submit',async()=>{
 state.save.mockRejectedValueOnce(new TypeError('Raw server detail should not appear')).mockResolvedValueOnce({});await render();await change('Observed target','component:inactive');await change('Evidence source reference','Synthetic source');await submit();expect(host.querySelector('form fieldset')!.hasAttribute('disabled')).toBe(true);expect(host.textContent).toContain('Retry identical observation');expect(host.textContent).not.toContain('Raw server detail');await submit();expect(state.save.mock.calls[0]).toEqual(state.save.mock.calls[1]);
});
it('blocks duplicate submits while save is unresolved',async()=>{
 let release!:(v:any)=>void;state.save.mockImplementation(()=>new Promise(r=>release=r));await render();await change('Observed target','component:active');await change('Evidence source reference','Synthetic source');await submit();await submit();expect(state.save).toHaveBeenCalledTimes(1);await act(async()=>release({}));
});
it('permits retained retired target history but hides writes for technician or decommissioned opening',async()=>{
 await render();await change('Observed target','component:retired');await change('Evidence source reference','Historic record');await submit();expect(state.save.mock.calls[0][0].payload.target.id).toBe('retired');state.auth={...state.auth,role:'technician'};state.stored=state.auth;await render();expect(host.querySelector('form')).toBeNull();state.auth={...state.auth,role:'admin'};state.stored=state.auth;state.read.mockResolvedValue({...snapshot(),status:'decommissioned'});await render();expect(host.querySelector('form')).toBeNull();
});
it('clears account content and ignores delayed old response after account loss',async()=>{
 let release!:(v:any)=>void;state.read.mockImplementation(()=>new Promise(r=>release=r));await render();state.stored={...state.auth,userId:'b'};await act(async()=>vi.advanceTimersByTimeAsync(1000));await act(async()=>release(snapshot()));expect(host.textContent).not.toContain('Historic maintenance log');expect(host.querySelector('form')).toBeNull();expect(host.textContent).toContain('Account changed');
});
it('resets removed targets after explicit reload and refuses an unavailable target',async()=>{
 await render();await change('Observed target','component:inactive');await change('Evidence source reference','Synthetic source');state.read.mockResolvedValue({...snapshot(),targets:[]});await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Reload saved observations')!.click());await submit();expect(state.save).not.toHaveBeenCalled();expect(host.textContent).toContain('Choose an available target');
});
it('does not restore content or announce success when the account changes during save',async()=>{
 let release!:(v:any)=>void;state.save.mockImplementation(()=>new Promise(r=>release=r));await render();await change('Observed target','frame:frame');await change('Evidence source reference','Synthetic frame inspection');await submit();expect(state.save.mock.calls[0][0].payload.target).toEqual({type:'frame',id:'frame'});state.stored={...state.auth,userId:'b'};await act(async()=>vi.advanceTimersByTimeAsync(1000));await act(async()=>release({}));expect(host.textContent).not.toContain('Historic maintenance log');expect(host.textContent).not.toContain('Observation recorded.');expect(host.querySelector('form')).toBeNull();expect(state.read).toHaveBeenCalledTimes(1);
});
