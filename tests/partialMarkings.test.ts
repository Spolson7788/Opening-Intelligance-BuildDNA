import {it,expect} from 'vitest';
import {partialCatalogCandidates} from '../src/services/partialMarkings';
import type {LabelRead} from '../src/services/labelReading';
const read=(vision_text:string,ocr_text=''):LabelRead=>({region:{photo_index:0,x:0,y:0,w:1,h:1,rotation:0},vision_text,ocr_text,ocr_confidence:0,agreed_markings:[],status:'unconfirmed'});
const catalog=[{manufacturer:'LCN',model:'4040XP'},{manufacturer:'LCN',model:'4041 DA'},{manufacturer:'Cal-Royal',model:'CR441'}];
it('resolves obscured suffixes against catalog candidates while preserving actual partial characters',()=>{
 expect(partialCatalogCandidates([read('4040X?')],catalog)).toMatchObject([{manufacturer:'LCN',model:null,transcribed_marking:'4040X?',manufacturer_basis:'catalog_partial_model_match'}]);
 expect(partialCatalogCandidates([read('CR4?1')],catalog)[0].model).toBeNull();
});
it('keeps multiple matching products unresolved, including cross-brand lookalikes',()=>{
 const values=partialCatalogCandidates([read('404? ??')],catalog);
 expect(values.map(c=>c.model)).toEqual([null,null]);
 expect(values.map(c=>c.catalog_model)).toEqual(['4040XP','4041 DA']);
 expect(partialCatalogCandidates([read('CR4?1')],[...catalog,{manufacturer:'Other',model:'CR441'}])).toHaveLength(2);
});
it('does not replace known characters, accept weak fragments, or bypass a known brand or conflicting OCR',()=>{
 expect(partialCatalogCandidates([read('4O40X?')],catalog)).toEqual([]);
 expect(partialCatalogCandidates([read('40??')],catalog)).toEqual([]);
 expect(partialCatalogCandidates([read('4040X?')],catalog,'Cal-Royal')).toEqual([]);
 expect(partialCatalogCandidates([read('4040X?','4041')],catalog)).toEqual([]);
 expect(partialCatalogCandidates([read('unreadable')],catalog)).toEqual([]);
});
