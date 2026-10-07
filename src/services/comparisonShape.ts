// Provider fields are an allowlist; verification and UI decision fields are server-owned.
export function comparisonShape(value:any,pages?:{brand:string;models:string[]}[]){
 const adjustments:any[]=[];
 const drop=(field:string,entry:unknown,reason='invalid_comparison_shape')=>{adjustments.push({field,entry,reason});};
 const array=(v:any,field:string)=>{if(Array.isArray(v))return v;if(v!==undefined)drop(field,v);return [];};
 const text=(v:any)=>typeof v==='string'&&v.trim()?v.trim():null;
 const norm=(v:string)=>v.toUpperCase().replace(/[^A-Z0-9]/g,'');
 const features=(v:any,field:string)=>array(v,field).flatMap(e=>{if(!e||typeof e!=='object'||Array.isArray(e)||!text(e.observation)){drop(field,e);return [];}return [{observation:e.observation.trim(),citation:e.citation&&typeof e.citation==='object'&&!Array.isArray(e.citation)?e.citation:null}];});
 const candidates=array(value?.candidates,'candidates').flatMap(c=>{
  if(!c||typeof c!=='object'||Array.isArray(c)){drop('candidate',c);return [];}
  for(const key of Object.keys(c))if(!['manufacturer','series','model','supporting_features','contradicting_features'].includes(key))drop('candidate.'+key,c[key],'provider_field_not_allowed');
  const manufacturer=text(c.manufacturer),model=text(c.model),series=text(c.series);
  const inReference=manufacturer&&(model||series)&&pages?.some(p=>norm(p.brand)===norm(manufacturer)&&p.models.some(m=>norm(m)===norm((model||series)!)));
  if(pages&&!inReference){drop('candidate',c,'candidate_outside_reference_set');return [];}
  return [{manufacturer,model,series,supporting_features:features(c.supporting_features,'supporting_features'),contradicting_features:features(c.contradicting_features,'contradicting_features')}];
 });
 const unresolved=array(value?.unresolved,'unresolved').flatMap(v=>{if(typeof v==='string')return [v];drop('unresolved',v);return [];});
 const citations=array(value?.citations,'citations').filter(c=>{if(c&&typeof c==='object'&&!Array.isArray(c))return true;drop('citations',c);return false;});
 for(const key of Object.keys(value||{}))if(!['candidates','unresolved','citations'].includes(key))drop(key,value[key],'provider_field_not_allowed');
 return {candidates,unresolved,citations,reasoning_adjustments:adjustments};
}
