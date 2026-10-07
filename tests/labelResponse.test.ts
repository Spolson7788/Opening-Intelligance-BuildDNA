import {it,expect} from 'vitest';
import {parseLabelResponse,labelReadContract} from '../src/services/labelResponse';
const body=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
it('retains four transcriptions and distinguishes missing crops from explicit empty reads',()=>{
 const parsed=parseLabelResponse(body({reads:[0,3,4,5].map(crop_index=>({crop_index,text:'4040XP'}))}),'label_reader',6);
 expect(parsed.reads.map((r:any)=>r.text)).toEqual(Array(4).fill('4040XP'));
 expect(parsed.validation).toMatchObject({status:'partial',not_returned:[1,2],invalid_crops:[]});
 const empty=parseLabelResponse(body({reads:[{crop_index:0,text:''}]}),'label_reader',1);
 expect(empty.validation.status).toBe('completed');expect(empty.reads[0].text).toBe('');
});
it('drops an extra index without destroying six valid entries or repairing their text',()=>{
 const parsed=parseLabelResponse(body({reads:Array.from({length:7},(_,crop_index)=>({crop_index,text:'1C40X?'}))}),'label_reader',6);
 expect(parsed.reads).toHaveLength(6);expect(parsed.reads.every((r:any)=>r.text==='1C40X?')).toBe(true);
 expect(parsed.validation.issues).toEqual([{entry_index:6,crop_index:6,reason:'crop_index_out_of_range'}]);
});
it('rejects ambiguous duplicates and null texts independently, preserving unrelated crops',()=>{
 const parsed=parseLabelResponse(body({reads:[{crop_index:0,text:'1040XP'},{crop_index:0,text:'4040XP'},{crop_index:1,text:null},{crop_index:2,text:'4?40XP'},null,{crop_index:-1,text:'bad'}]}),'label_reader',4);
 expect(parsed.reads).toEqual([{crop_index:2,text:'4?40XP'}]);
 expect(parsed.validation.invalid_crops).toEqual([0,1]);expect(parsed.validation.not_returned).toEqual([3]);
 expect(parsed.validation.issues.map((r:any)=>r.reason)).toEqual(['duplicate_crop_index','invalid_text','invalid_crop_index','crop_index_out_of_range','not_returned']);
});
it('uses supplied indices for a focused reread, without inferring a one-based mapping',()=>{
 const parsed=parseLabelResponse(body({reads:[{crop_index:'3',text:'1C40X?'},{crop_index:1,text:'bad'}]}),'label_reread',[3,5]);
 expect(parsed.reads).toEqual([{crop_index:3,text:'1C40X?'}]);expect(parsed.validation.not_returned).toEqual([5]);
 expect(labelReadContract([3,5])).toContain('exactly 2 reads');expect(labelReadContract([3,5])).toContain('[3,5]');
});
it('continues rejecting malformed envelopes, refusals, truncations and non-list reads',()=>{
 expect(()=>parseLabelResponse(body({reads:null}),'label_reader',1)).toThrow('label_invalid_reads');
 expect(()=>parseLabelResponse({stop_reason:'refusal'},'label_reader',1)).toThrow('label_refused');
 expect(()=>parseLabelResponse({stop_reason:'max_tokens'},'label_reader',1)).toThrow('label_truncated');
 expect(()=>parseLabelResponse({content:[{type:'text',text:'broken'}]},'label_reader',1)).toThrow('label_invalid_json');
});

it('preserves an exact model read in a single JSON fence after explanatory prose',()=>{
 const value={reads:[{crop_index:0,text:'PANIC HARDWARE\nModel 6200R',source:'native_tile',tile_index:10,text_box:{x:.25,y:.15,w:.35,h:.35},rotation:0,target_device:true}],limiting_factor:'none'};
 const parsed=parseLabelResponse({content:[{type:'text',text:'The sticker is visible on the target hardware.\n```json\n'+JSON.stringify(value)+'\n```'}]},'label_reader',[0]);
 expect(parsed.reads).toEqual(value.reads);expect(parsed.response_format).toBe('single_json_fence_with_prose');
});
it('rejects ambiguous, malformed or incomplete fenced replies instead of choosing or repairing text',()=>{
 const fence='```json\n'+JSON.stringify({reads:[{crop_index:0,text:'6200R'}]})+'\n```';
 for(const text of [fence+'\n'+fence,'Another object {}\n'+fence,'Explanation\n```json\n{"reads": [}\n```','Explanation\n```json\n[]\n```'])expect(()=>parseLabelResponse({content:[{type:'text',text}]},'label_reader',[0])).toThrow('label_invalid_json');
 for(const stop_reason of ['refusal','max_tokens'])expect(()=>parseLabelResponse({stop_reason,content:[{type:'text',text:'Explanation\n'+fence}]},'label_reader',[0])).toThrow();
});

it('retains text but flags a descriptive device name as invalid association, never boolean proof',()=>{
 const parsed=parseLabelResponse({content:[{type:'text',text:JSON.stringify({reads:[{crop_index:0,text:'PDQ',source:'focused_crop',target_device:'panic hardware exit device'},{crop_index:1,text:'6200R',source:'focused_crop',target_device:true}]})}]},'label_reread',[0,1]);
 expect(parsed.reads).toHaveLength(2);expect(parsed.reads[0].target_device).toBe('panic hardware exit device');
 expect(parsed.validation).toMatchObject({status:'partial',issues:[{crop_index:0,reason:'invalid_target_device'}]});
});
