// Offline only. Input is a private provider-attempt export; never sends requests.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseLabelResponse} from '../../src/services/labelResponse';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: replay-label-replies.ts private-export.json output.json');
const bytes=readFileSync(input);const value=JSON.parse(bytes.toString());
const rows=Array.isArray(value)?value:value.provider_attempts;
if(!Array.isArray(rows))throw Error('Invalid provider attempt export');
const results=rows.filter((r:any)=>r.stage==='label_reader'&&r.raw_output).map((r:any)=>{
 const expected=r.request_manifest.flatMap((m:any)=>m.content).flatMap((b:any)=>{
  const match=typeof b.text==='string'&&b.text.match(/^(?:Detected label crop|Search area \(not a detected label\)) (\d+): original crop$/);const targeted=typeof b.text==='string'&&b.text.match(/^(?:Maker mark|Product label) crop (\d+), from photograph \d+\./);return match?[Number(match[1])]:targeted?[Number(targeted[1])]:[];
 });
 if(!expected.length)throw Error('Missing crop manifest');
 try{const result=parseLabelResponse(JSON.parse(r.raw_output),'label_reader',expected);return {run_id:r.run_id,attempt_id:r.id,expected,result};}
 catch(e){return {run_id:r.run_id,attempt_id:r.id,expected,error:(e as Error).message};}
});
writeFileSync(output,JSON.stringify({source_sha256:createHash('sha256').update(bytes).digest('hex'),replay_version:'batch0-label-response-2',results},null,2)+'\n');
console.log(JSON.stringify({replayed:results.length,partial:results.filter(r=>r.result?.validation.status==='partial').length,failed:results.filter(r=>r.error).length}));
