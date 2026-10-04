// Offline scoring only. Ground truth must come from independent human review.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const tokens=text=>String(text||'').toUpperCase().match(/[A-Z0-9]+(?:-[A-Z0-9]+)*/g)||[];
export function scoreLabels(cases){
 const seen=new Set();let readable=0,correct=0,wrong=0,abstained=0,unreadable=0,falseReads=0;
 for(const c of cases){
  if(typeof c.case_id!=='string'||seen.has(c.case_id)||c.split!=='held_out'||typeof c.human_readable!=='boolean'||!Array.isArray(c.expected_markings)||!Array.isArray(c.read_markings))throw Error('invalid_or_duplicate_held_out_case');
  seen.add(c.case_id);
  const expected=c.expected_markings.flatMap(tokens),actual=c.read_markings.flatMap(tokens);
  if(!c.human_readable){unreadable++;if(actual.length)falseReads++;continue;}
  if(!expected.length)throw Error('readable_case_requires_ground_truth');
  readable++;
  if(!actual.length){abstained++;continue;}
  // Model identifiers are exact: 4040XP does not match 4040 or 4041DA.
  if(expected.every(t=>actual.includes(t))&&actual.every(t=>expected.includes(t)))correct++;else wrong++;
 }
 const rate=readable?correct/readable:null;
 const z=1.96,n=readable,p=rate||0;
 const lower=n?(p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n):null;
 return {cases:cases.length,readable_labels:readable,correct_readings:correct,wrong_readings:wrong,abstentions:abstained,unreadable_labels:unreadable,false_readings_on_unreadable_labels:falseReads,
  exact_reading_accuracy:rate,accuracy_95_percent_lower_bound:lower,target:.9,
  point_target_met:rate!==null&&rate>=.9,
  release_target_demonstrated:readable>=100&&lower!==null&&lower>=.9&&falseReads===0,
  note:'Readable-label denominator includes abstentions. Model self-confidence and technician-entered hints are not measured accuracy.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const rows=readFileSync(process.argv[2],'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
 console.log(JSON.stringify(scoreLabels(rows),null,2));
}
