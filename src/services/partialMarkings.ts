import type {LabelRead,LabelEvidence} from './labelReading';
export interface CatalogModel {manufacturer:string;model:string;series?:string|null}
const normalized=(s:string)=>s.toUpperCase().replace(/[\s_-]/g,'');
export function partialMarkings(reads:LabelRead[]):string[]{
 return [...new Set(reads.flatMap(r=>(r.vision_text.toUpperCase().match(/[A-Z0-9?]+(?:[- ][A-Z0-9?]+)*/g)||[]).flatMap(raw=>{
  // Treat whitespace-separated words independently as well as model tokens.
  return [raw,...raw.split(/\s+/)].filter(token=>{
   const n=normalized(token);return n.length<=24&&n.includes('?')&&(n.match(/\?/g)||[]).length<=3&&(n.match(/[A-Z0-9]/g)||[]).length>=3&&(n.match(/\d/g)||[]).length>=2;
  });
 })))].slice(0,20);
}
export function partialCatalogCandidates(reads:LabelRead[],catalog:CatalogModel[],brand=''):NonNullable<LabelEvidence['candidates']>{
 const result:NonNullable<LabelEvidence['candidates']>=[];
 for(const marking of partialMarkings(reads)){
  const pattern=normalized(marking);
  for(const entry of catalog){
   if(brand&&normalized(entry.manufacturer)!==normalized(brand))continue;
   const model=normalized(entry.model);
   if(model.length!==pattern.length||![...pattern].every((c,i)=>c==='?'||c===model[i]))continue;
   const relevant=reads.filter(r=>normalized(r.vision_text).includes(pattern));
   const digits=model.match(/\d{4}/)?.[0];
   if(digits&&relevant.some(r=>(r.ocr_text.match(/\b\d{4}\b/g)||[]).some(v=>v!==digits)))continue;
   result.push({manufacturer:entry.manufacturer,model:entry.model,series:entry.series||digits||entry.model,verification:'single_reader',manufacturer_basis:'catalog_partial_model_match',transcribed_marking:marking});
  }
 }
 return [...new Map(result.map(c=>[`${c.manufacturer}:${c.model}`,c])).values()].slice(0,6);
}
