// Free, deterministic scoring. Run output is never used as technician truth.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const normalize=value=>typeof value==='string'?value.trim().toUpperCase().replace(/[\s_-]/g,''):'';
export function truthsFromConfirmations(exported){
 const grouped=new Map();
 const history=exported.technician_confirmations||[];
 const superseded=new Set(history.map(c=>c.supersedes_id).filter(Boolean));
 for(const confirmation of history){
  if(superseded.has(confirmation.id)||!confirmation.acknowledged_by||!confirmation.acknowledged_at)continue;
  if(!confirmation.provenance&&(confirmation.identity_status!=='established'||!['technician_identified','photo_suggestion'].includes(confirmation.identity_source)))continue;
  const previous=grouped.get(confirmation.run_id);
  if(previous&&(normalize(previous.manufacturer)!==normalize(confirmation.manufacturer)||normalize(previous.model)!==normalize(confirmation.model)))throw Error('conflicting_technician_confirmations');
  grouped.set(confirmation.run_id,confirmation);
 }
 return exported.runs.map(run=>{
  const c=grouped.get(run.id);
  return c?{run_id:run.id,device_id:c.hardware_component_id,manufacturer:c.manufacturer,series:c.series,series_basis:c.series_basis,model:c.model,acknowledged:true,acknowledged_by:c.acknowledged_by,acknowledged_at:c.acknowledged_at,split:'development'}:{run_id:run.id,acknowledged:false};
 });
}
export function scoreFieldIdentities(exported,truths){
 if(!Array.isArray(exported?.runs)||!Array.isArray(truths))throw Error('invalid_scoring_input');
 const runs=new Map();
 for(const run of exported.runs){if(!run.id||runs.has(run.id))throw Error('duplicate_or_missing_run_id');runs.set(run.id,run);}
 const seen=new Set(),scored=[],pending=[],misses=[];
 const builds=new Set(exported.runs.map(r=>r.stage_one?.recognition_versions?.build_sha));
 if(builds.size!==1||![...builds].every(b=>typeof b==='string'&&/^[a-f0-9]{40}$/i.test(b)))throw Error('mixed_or_unstamped_builds');
 const outcomes=Object.fromEntries(['manufacturer','series','model'].map(f=>[f,{correct:0,wrong:0,abstain:0,conflict:0}]));
 const totals=Object.fromEntries(['manufacturer','series','model'].map(field=>[field,{correct:0,total:0}]));
 let unreadableLogos=0,unresolvedUnreadableLogos=0,silhouetteBrands=0,reviewedBrandBasis=0;
 for(const truth of truths){
  if(!truth.run_id||seen.has(truth.run_id))throw Error('duplicate_or_missing_truth_run_id');seen.add(truth.run_id);
  const run=runs.get(truth.run_id);if(!run)throw Error('truth_run_not_in_export');
  if(truth.acknowledged!==true){pending.push({run_id:truth.run_id,reason:'technician_acknowledgment_pending'});continue;}
  if(!truth.device_id||!normalize(truth.manufacturer)||!normalize(truth.model)||!truth.acknowledged_by||!Number.isFinite(Date.parse(truth.acknowledged_at)))throw Error('incomplete_acknowledged_truth');
  if(!['development','held_out'].includes(truth.split))throw Error('truth_split_required');
  if(!run.suggestion||['running','failed'].includes(run.status)){
   pending.push({run_id:truth.run_id,reason:'no_final_recognition_result'});continue;
  }
  const actual=run.suggestion,fields={},fieldOutcomes={};
  for(const field of ['manufacturer','series','model']){
   if(!normalize(truth[field]))continue;
   const correct=normalize(actual[field])===normalize(truth[field]);
   const conflict=['CONFLICT','TYPE_CONFLICT'].includes(run.stage_one?.catalog_identity_review?.status);
   const outcome=conflict?'conflict':correct?'correct':normalize(actual[field])?'wrong':'abstain';
   fieldOutcomes[field]=outcome;outcomes[field][outcome]++;
   fields[field]=outcome==='correct';totals[field].total++;if(outcome==='correct')totals[field].correct++;
   if(outcome!=='correct')misses.push({run_id:run.id,device_id:truth.device_id,field,expected:truth[field],actual:actual[field]||null,
    kind:outcome==='conflict'?'conflicting_identity':normalize(actual[field])?'wrong_identity':'unresolved_identity',
    proposed_fix:field==='manufacturer'?'Review maker-mark crop/read and catalog pair; preserve disagreements.':'Review exact label transcription and catalog designation, including suffixes.'});
  }
  if(truth.logo_readable===false){unreadableLogos++;if(!normalize(actual.manufacturer))unresolvedUnreadableLogos++;}
  // This is a human-reviewed cause, not an inference from a missing logo alone.
  if(truth.predicted_brand_basis){reviewedBrandBasis++;if(normalize(actual.manufacturer)&&['silhouette','holes'].includes(truth.predicted_brand_basis)){
   silhouetteBrands++;misses.push({run_id:run.id,device_id:truth.device_id,kind:'brand_from_silhouette_or_holes',actual:actual.manufacturer,proposed_fix:'Remove identity promotion from shared shape/mounting evidence; keep it as a candidate clue.'});
  }}
  scored.push({run_id:run.id,device_id:truth.device_id,split:truth.split,fields,field_outcomes:fieldOutcomes,
   actual:{manufacturer:actual.manufacturer||null,series:actual.series||null,model:actual.model||null},
   truth:{manufacturer:truth.manufacturer,series:truth.series||null,model:truth.model},
   acknowledged_by:truth.acknowledged_by,acknowledged_at:truth.acknowledged_at,
   catalog_review:run.stage_one?.catalog_identity_review||null});
 }
 const distinctDevices=new Set(scored.map(s=>s.device_id)).size;
 const heldOutDevices=new Set(scored.filter(s=>s.split==='held_out').map(s=>s.device_id)).size;
 return {version:'oi-field-identity-score-2',build_sha:[...builds][0],scored_runs:scored.length,distinct_devices:distinctDevices,held_out_devices:heldOutDevices,
  field_counts:totals,field_outcomes:outcomes,
  precision_and_coverage:Object.fromEntries(Object.entries(outcomes).map(([field,v])=>[field,{precision:v.correct+v.wrong?v.correct/(v.correct+v.wrong):null,coverage:totals[field].total?(v.correct+v.wrong)/totals[field].total:null}])),
  // Small development sets have counts, never headline accuracy figures.
  accuracy:heldOutDevices>=20&&heldOutDevices===scored.length&&scored.every(s=>s.split==='held_out')?Object.fromEntries(Object.entries(totals).map(([f,v])=>[f,v.total?v.correct/v.total:null])):null,
  unresolved_when_logo_unreadable:{unresolved:unresolvedUnreadableLogos,total:unreadableLogos},
  brand_from_silhouette_or_holes:{count:silhouetteBrands,reviewed_runs:reviewedBrandBasis},
  scored,pending,miss_queue:misses,
  rollout_verdict:'NOT_READY: scoring evidence alone does not establish capture, confirmation, miss-resolution or held-out rollout readiness.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const exported=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const truths=process.argv[3]?JSON.parse(readFileSync(process.argv[3],'utf8')):truthsFromConfirmations(exported);
 console.log(JSON.stringify(scoreFieldIdentities(exported,truths),null,2));
}
