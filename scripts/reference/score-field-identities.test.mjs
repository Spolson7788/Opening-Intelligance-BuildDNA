import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreFieldIdentities,truthsFromConfirmations} from './score-field-identities.mjs';
const truth={run_id:'run-1',device_id:'device-1',manufacturer:'PDQ',series:'6200',model:'6200R',acknowledged:true,acknowledged_by:'tech',acknowledged_at:'2026-10-07T14:00:00Z',split:'development',logo_readable:true};
const run={id:'run-1',status:'no_reference_evidence',suggestion:{manufacturer:null,series:null,model:null},stage_one:{photograph_identity:{manufacturer:'DORMA',model:'6200R'}}};
test('scores the final result, preserves exact model suffixes, and queues misses',()=>{
 const r=scoreFieldIdentities({runs:[run]},[truth]);
 assert.deepEqual(r.field_counts.model,{correct:0,total:1});assert.equal(r.miss_queue.length,3);assert.equal(r.accuracy,null);
 const wrong={...run,suggestion:{manufacturer:'PDQ',series:'6200',model:'6200RF'}};
 assert.equal(scoreFieldIdentities({runs:[wrong]},[truth]).field_counts.model.correct,0);
});
test('pending acknowledgment cannot become a score or confirmed example',()=>{
 const r=scoreFieldIdentities({runs:[run]},[{...truth,acknowledged:false}]);
 assert.equal(r.scored_runs,0);assert.equal(r.pending.length,1);assert.equal(r.miss_queue.length,0);
 assert.throws(()=>scoreFieldIdentities({runs:[run]},[{...truth,acknowledged_by:''}]),/incomplete/);
});
test('repeated runs of one device cannot satisfy the held-out device threshold',()=>{
 const runs=Array.from({length:30},(_,i)=>({...run,id:`run-${i}`}));
 const truths=runs.map(r=>({...truth,run_id:r.id,split:'held_out'}));
 const result=scoreFieldIdentities({runs},truths);assert.equal(result.held_out_devices,1);assert.equal(result.accuracy,null);
});
test('missing logo does not prove a silhouette cause; human-reviewed cause is required',()=>{
 const guessed={...run,suggestion:{manufacturer:'DORMA',series:null,model:'6200R'}};
 const r=scoreFieldIdentities({runs:[guessed]},[{...truth,logo_readable:false}]);
 assert.deepEqual(r.brand_from_silhouette_or_holes,{count:0,reviewed_runs:0});
 const reviewed=scoreFieldIdentities({runs:[guessed]},[{...truth,logo_readable:false,predicted_brand_basis:'holes'}]);
 assert.equal(reviewed.brand_from_silhouette_or_holes.count,1);
});
test('rejects unmatched/duplicate run links and excludes interrupted runs from accuracy',()=>{
 assert.throws(()=>scoreFieldIdentities({runs:[run]},[{...truth,run_id:'other'}]),/not_in_export/);
 assert.throws(()=>scoreFieldIdentities({runs:[run,run]},[truth]),/duplicate/);
 assert.throws(()=>scoreFieldIdentities({runs:[run]},[truth,truth]),/duplicate/);
 assert.equal(scoreFieldIdentities({runs:[{...run,status:'failed'}]},[truth]).scored_runs,0);
});
test('automatic truth uses acknowledged installed hardware, never classifier or submitted hints',()=>{
 const exported={runs:[run],technician_confirmations:[]};
 assert.equal(truthsFromConfirmations(exported)[0].acknowledged,false);
 const c={run_id:run.id,hardware_component_id:'component-1',manufacturer:'PDQ',model:'6200R',identity_status:'established',identity_source:'technician_identified',acknowledged_by:'tech',acknowledged_at:truth.acknowledged_at};
 const confirmed=truthsFromConfirmations({...exported,technician_confirmations:[c]})[0];
 assert.equal(confirmed.manufacturer,'PDQ');assert.equal(confirmed.series,undefined);assert.equal(confirmed.split,'development');
 assert.throws(()=>truthsFromConfirmations({...exported,technician_confirmations:[c,{...c,manufacturer:'DORMA'}]}),/conflicting/);
});
