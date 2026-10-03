import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn()}}));
import {sourceQuote,validateCitations,compareWithReferences,type ReferencePage} from '../src/services/referenceEvidence';
const text='Heavy-Duty Double Lever Arm with Extra Smooth Action\n     Full Feature Multi-Size Commercial Door Closer for Use In Office\nStandard Packaging includes Full Plastic Cover with Sex Bolts\n     and Screws. (Metal Optional)';
const page:ReferencePage={page_id:'source#p1',doc_sha256:'source',page_no:1,text,text_sha256:'text-hash',brand:'Example',title:'Fixture',image_key:null,models:['fixture']};
const citation={page_id:page.page_id,doc_sha256:page.doc_sha256,page_no:1,quote:'Standard Packaging includes Full Plastic Cover with Sex Bolts and Screws. (Metal Optional)'};
describe('layout-safe source citations',()=>{
 it('accepts wrapped text and returns the exact original source span',()=>{
  const result=validateCitations([citation],[page]);
  expect(result.rejected).toEqual([]);
  expect(result.accepted[0].quote).toContain('Bolts\n     and');
  expect(text.includes(result.accepted[0].quote)).toBe(true);
 });
 it('preserves punctuation, case, numbers and intervening column content',()=>{
  for(const quote of ['Metal optional','Metal, Optional','Full Metal Cover','(Metal Optional!)'])expect(sourceQuote(text,quote)).toBeNull();
  expect(sourceQuote('Size 1 thru 6','Size 1 thru 5')).toBeNull();
  expect(sourceQuote('Closing Speed\n DOOR WIDTH 36”\n Regulating Valves','Closing Speed Regulating Valves')).toBeNull();
 });
 it('rejects mismatched page identity, malformed objects and empty quotes',()=>{
  const bad=[{...citation,doc_sha256:'other'},{...citation,page_no:2},{...citation,page_id:'other'},null,'source#p1 quote',{...citation,quote:'   '}];
  expect(validateCitations(bad,[page])).toEqual({accepted:[],rejected:bad});
 });
 it('escapes regular expression syntax in source quotations',()=>{
  expect(sourceQuote('A. (size 1 thru 6)\n + adjustment','A. (size 1 thru 6) + adjustment')).toBe('A. (size 1 thru 6)\n + adjustment');
  expect(sourceQuote('Ax size 1 thru 6 + adjustment','A. (size 1 thru 6) + adjustment')).toBeNull();
 });
 it('provides compact text and explicit structured citation instructions to the provider',async()=>{
  const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({content:[{type:'text',text:'{"candidates":[],"citations":[],"unresolved":[]}'}]})});
  vi.stubGlobal('fetch',fetch);
  try{
   await compareWithReferences({images:[],media_type:'image/jpeg',stage_one:{},attributes:{},pages:[page],conflicts:[]});
   const body=JSON.parse(fetch.mock.calls[0][1].body);
   const prompt=body.messages[0].content[0].text;
   expect(prompt).toContain('never a string');
   const payload=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
   expect(payload.pages[0].text).toBe(text.replace(/\s+/g,' ').trim());
   expect(page.text).toBe(text);
  }finally{vi.unstubAllGlobals();}
 });
});
