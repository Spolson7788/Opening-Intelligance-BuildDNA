import {z} from 'zod';
import {installationDateSchema} from './installationFacts';
const instant=z.string().datetime({offset:true}).refine(s=>Number.isFinite(Date.parse(s)),'Invalid instant');
const boundary=z.object({certainty:z.enum(['confirmed','estimated','unknown']),earliest:instant.nullable(),latest:instant.nullable()}).strict().refine(v=>v.certainty==='unknown'?v.earliest===null&&v.latest===null:!!v.earliest&&!!v.latest&&Date.parse(v.earliest)<=Date.parse(v.latest)&&(v.certainty!=='confirmed'||Date.parse(v.earliest)===Date.parse(v.latest)));
const correction={correction_of:z.string().uuid().nullable(),correction_reason:z.string().trim().max(2000)};
const source={source_reference:z.string().trim().min(1).max(1000),note:z.string().trim().max(4000)};
export const downtimeSchema=z.object({...correction,...source,component_ids:z.array(z.string().uuid()).max(100),availability:z.enum(['unavailable','restricted']),start:boundary,end:boundary,impact:z.string().trim().max(2000)}).strict().refine(p=>new Set(p.component_ids).size===p.component_ids.length).refine(p=>!p.correction_of||!!p.correction_reason).refine(p=>!p.start.earliest||!p.end.latest||Date.parse(p.start.earliest)<=Date.parse(p.end.latest));
export const warrantySchema=z.object({...correction,...source,component_id:z.string().uuid(),warranty_type:z.enum(['product','labor']),record_status:z.enum(['unknown','documented']),issuer:z.string().trim().max(300),terms:z.string().trim().max(8000),start_trigger:z.string().trim().max(300),start_date:installationDateSchema,stated_expiry:installationDateSchema,exclusions:z.string().trim().max(4000),claim_instructions:z.string().trim().max(4000),proof_reference:z.string().trim().max(1000),proof_document_version_id:z.string().uuid().nullable().optional()}).strict().refine(p=>!p.correction_of||!!p.correction_reason).refine(p=>p.record_status==='unknown'||!!p.issuer&&!!p.terms&&!!p.proof_reference,'Documented terms require issuer, terms and proof reference.');
function union(intervals:number[][]){let end=-Infinity,total=0;for(const [a,b] of intervals.sort((x,y)=>x[0]-y[0])){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total/60000;}
// At opening level, multiple component intervals are unioned, never summed per target.
export function downtimeSummary(records:any[]){
 return Object.fromEntries(['unavailable','restricted'].map(kind=>{
  const rows=records.filter(r=>r.kind==='downtime'&&r.is_current&&r.payload.availability===kind).map(r=>r.payload);
  const lower:number[][]=[],upper:number[][]=[];let unresolved=0,estimated=0;
  for(const p of rows){
   if(p.start.certainty==='estimated'||p.end.certainty==='estimated')estimated++;
   if(!p.start.earliest||!p.end.latest){unresolved++;continue;}
   const a=Date.parse(p.start.latest),b=Date.parse(p.end.earliest);if(b>a)lower.push([a,b]);
   upper.push([Date.parse(p.start.earliest),Date.parse(p.end.latest)]);
  }
  return [kind,{guaranteed_minutes:union(lower),possible_minutes:unresolved?null:union(upper),unresolved_intervals:unresolved,estimated_intervals:estimated,record_count:rows.length}];
 }));
}
