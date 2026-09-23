import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {correctiveSummary,serviceSummary,loadQuarterServiceSummary} from '../site/connected.mjs';
test('Corrective estimates exclude serviceable and refused parts; unknown estimates remain explicit',()=>{
  assert.deepEqual(correctiveSummary([
    {disposition:'replace',repair_cost:250},
    {disposition:'serviceable',repair_cost:0},
    {disposition:'serviceable',repair_cost:500},
    {disposition:'refused',repair_cost:900},
    {disposition:'replace',repair_cost:null},
    {disposition:'replace',repair_cost:85,work_completed_at:'2026-09-21'}
  ]),{cost:250,priced:1,unpriced:1});
});
test('Recorded event costs are separate from component repair estimates',()=>{
  assert.deepEqual(serviceSummary([{cost:85},{cost:null},{cost:'0'}]),{cost:85,count:3,unpriced:1});
});
test('Missing or invalid costs do not become recorded zero costs',()=>{
  assert.deepEqual(serviceSummary([{cost:''},{cost:undefined},{cost:-1},{cost:'invalid'}]),{cost:0,count:4,unpriced:4});
  assert.deepEqual(serviceSummary([{cost:'0.10'},{cost:'0.20'}]),{cost:0.3,count:2,unpriced:0});
});
function backend(failSecond=false){
  const calls=[];
  return {calls,from(table){const call={table};calls.push(call);const q={
    select(value){call.select=value;return q;},eq(key,value){call[key]=value;return q;},
    gte(key,value){call.start=value;return q;},lte(key,value){call.end=value;return q;},
    order(key){call.order=key;return q;},async range(start,end){call.range=[start,end];
      if(start&&failSecond)return {error:Error('request failed')};
      return {data:Array.from({length:start?1:500},(_,i)=>({id:start+i,cost:1}))};
    }};return q;}};
}
test('Service totals page beyond the first response and stay facility/quarter scoped',async()=>{
  const sb=backend(),now=new Date('2026-09-23T21:00:00Z');
  assert.deepEqual(await loadQuarterServiceSummary(sb,'facility-a',now),{cost:501,count:501,unpriced:0});
  assert.equal(sb.calls.length,2);
  assert.deepEqual(sb.calls.map(c=>c.range),[[0,499],[500,999]]);
  assert(sb.calls.every(c=>c.facility_id==='facility-a'&&c.end===now.toISOString()&&c.order==='id'));
  assert.equal(sb.calls[0].start,new Date(now.getFullYear(),6,1).toISOString());
});
test('A later-page failure rejects the total rather than showing incomplete money',async()=>{
  await assert.rejects(loadQuarterServiceSummary(backend(true),'facility-a'),/request failed/);
});
const html=readFileSync(new URL('../site/portal.html',import.meta.url),'utf8');
const renderCode=html.slice(html.indexOf('async function renderQuarterService('),html.indexOf('function renderService('));
const tileCode=html.match(/function tile\(lab,val,st,col\)\{[^\n]+/)[0];
async function renderServiceTile(total,options={}){
  const target={isConnected:options.connected!==false,outerHTML:'unchanged'};
  const render=new Function('$','loadQuarterServiceSummary','sb','current',tileCode+'\n'+renderCode+'\nreturn renderQuarterService;')(
    ()=>target,async()=>{if(options.error)throw Error('unavailable');return total;},{},{id:options.facility||'a'});
  await render('a');return target.outerHTML;
}
test('Service card uses recorded $85 and counts events, not components',async()=>{
  const text=await renderServiceTile({cost:85,count:1,unpriced:0});
  assert.match(text,/\$85/);assert.match(text,/1 service event · recorded costs/);
});
test('Missing costs and failed reads never render as completed $0',async()=>{
  const missing=await renderServiceTile({cost:0,count:1,unpriced:1});
  assert.match(missing,/Not recorded/);assert.doesNotMatch(missing,/\$0/);
  const failed=await renderServiceTile(null,{error:true});
  assert.match(failed,/unavailable/);assert.doesNotMatch(failed,/\$0/);
});
test('An old response cannot overwrite a different facility or detached card',async()=>{
  assert.equal(await renderServiceTile({cost:85,count:1,unpriced:0},{facility:'b'}),'unchanged');
  assert.equal(await renderServiceTile({cost:85,count:1,unpriced:0},{connected:false}),'unchanged');
});
