import {test} from 'node:test';import assert from 'node:assert/strict';import {scoreLabels} from './score-label-reading.mjs';
const row=(id,read=['LCN','4040XP'])=>({case_id:id,split:'held_out',human_readable:true,expected_markings:['LCN','4040XP'],read_markings:read});
test('scores exact markings without hiding abstentions or expanding a family into a model',()=>{
 const r=scoreLabels([row('1'),row('2',[]),row('3',['LCN','4040']),row('4',['LCN','4041DA'])]);
 assert.equal(r.exact_reading_accuracy,.25);assert.equal(r.wrong_readings,2);assert.equal(r.abstentions,1);assert.equal(r.release_target_demonstrated,false);
});
test('keeps fabricated readings on unreadable labels visible and rejects duplicate test identities',()=>{
 assert.equal(scoreLabels([{...row('1'),human_readable:false}]).false_readings_on_unreadable_labels,1);
 assert.throws(()=>scoreLabels([row('1'),row('1')]));
});
test('does not declare success on two easy examples or on a point estimate alone',()=>{
 assert.equal(scoreLabels([row('1'),row('2')]).release_target_demonstrated,false);
 const r=scoreLabels(Array.from({length:100},(_,i)=>row(String(i),i<90?['LCN','4040XP']:[])));
 assert.equal(r.point_target_met,true);assert.equal(r.release_target_demonstrated,false);
});
