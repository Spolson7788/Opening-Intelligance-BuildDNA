// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const {api,readFieldSession}=vi.hoisted(()=>({api:vi.fn(),readFieldSession:vi.fn()}));
vi.mock('../facility-dashboard/api-client.mjs',()=>({api,readFieldSession}));
import {showLabelPreview} from '../facility-dashboard/labels.mjs';
afterEach(()=>{document.querySelector('dialog')?.close();vi.clearAllMocks();});
it('discards an in-flight print response after the selected batch changes',async()=>{
  HTMLDialogElement.prototype.showModal=function(){};
  HTMLDialogElement.prototype.close=function(){this.dispatchEvent(new Event('close'));};
  readFieldSession.mockResolvedValue({userId:'u',organizationId:'o'});
  api.mockResolvedValueOnce({items:[{id:'a',eligible:true,facility_name:'F',building_name:'B',opening_code:'A',missing:[]},{id:'b',eligible:false,missing:['opening_not_complete']}]});
  await showLabelPreview([{id:'a'},{id:'b'}]);
  const checks=document.querySelectorAll<HTMLInputElement>('input');
  expect(checks[1].disabled).toBe(true);
  checks[0].checked=true;checks[0].dispatchEvent(new Event('change'));
  let resolve:any;api.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
  const generate=[...document.querySelectorAll('button')].find(b=>b.textContent==='Generate print file')!;
  generate.click();await vi.waitFor(()=>expect(api).toHaveBeenCalledTimes(2));
  checks[0].checked=false;checks[0].dispatchEvent(new Event('change'));
  resolve({items:[],count:1,template:'letter-2in-v1'});
  await new Promise(r=>setTimeout(r,0));
  expect(generate.disabled).toBe(true);
  expect(document.querySelector('#oi-label-print')).toBeNull();
  expect([...document.querySelectorAll('button')].find(b=>b.textContent==='Print / Save PDF')!.hidden).toBe(true);
  expect(api).toHaveBeenCalledTimes(2);
});
