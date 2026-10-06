import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
vi.mock('../src/services/recognitionAudit',()=>({auditedFetch:(url:string,init:RequestInit)=>fetch(url,init),recordRecognitionEvidence:vi.fn(),recognitionAuditStopped:()=>false}));
vi.mock('tesseract.js',()=>({PSM:{SINGLE_LINE:7,SPARSE_TEXT:11},createWorker:vi.fn(async()=>({setParameters:vi.fn(),recognize:vi.fn(async()=>({data:{text:'',confidence:0}})),terminate:vi.fn(async()=>{})}))}));
import {readLabels,applyLabelEvidence} from '../src/services/labelReading';
import {conservativeSuggestion} from '../src/services/referenceEvidence';
it('retains low-quality fixture observations without confirming identity',async()=>{
 const image=readFileSync(new URL('./fixtures/recognition/Installed_3.png',import.meta.url));
 expect(createHash('sha256').update(image).digest('hex')).toBe('4f46d88ad71d97bb9aff870efa56eccc82de8b17aafa8b381994e86c969b668f');
 const reply=(v:any)=>Response.json({content:[{type:'text',text:JSON.stringify(v)}]});
 // No product-specific coordinates supplied: broad search tiles, mocked text.
 const fetch=vi.fn().mockResolvedValueOnce(reply({regions:[]})).mockResolvedValueOnce(reply({reads:Array.from({length:5},(_,i)=>({crop_index:i,text:i===0?'1C40X?':'',legibility:i===0?'partial':'illegible'}))}));vi.stubGlobal('fetch',fetch);
 try{
  const labels=await readLabels([image],'image/png');expect(labels.legibility).toBe('partial');
  expect(labels.stage_outcomes?.label_reread).toMatchObject({status:'not_attempted',reason:'no_label_box'});
  const suggestion=conservativeSuggestion(applyLabelEvidence({component_class:'DOOR_CLOSER',manufacturer:null,series:null,model:null,confidence:{manufacturer:.7,model:.8},arm_attributes:{closer_type:'surface',mounting:'regular_arm',arm_type:'standard',cover_type:'none'}},labels),null);
  expect(suggestion).toMatchObject({component_class:'DOOR_CLOSER',manufacturer:null,model:null,confidence:{manufacturer:0,model:0},arm_attributes:{closer_type:'surface',mounting:'regular_arm',arm_type:'standard',cover_type:'none'}});
  expect(suggestion.visible_text).toEqual([]);expect(suggestion.unconfirmed_label_text[0].text).toBe('1C40X?');
 }finally{vi.unstubAllGlobals();}
});
it('withholds a model even when OCR agrees if recorded legibility is low',()=>{
 const suggestion=conservativeSuggestion({model:'4040XP',visible_text:['4040XP'],label_reading:{reads:[{legibility:'partial',vision_text:'4040XP',agreed_markings:['4040XP']}]},confidence:{model:.9}},null);
 expect(suggestion.model).toBeNull();expect(suggestion.confidence.model).toBe(0);
});
