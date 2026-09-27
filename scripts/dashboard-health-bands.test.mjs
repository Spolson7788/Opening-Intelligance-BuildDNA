import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {buildFacilityDashboard} from './build-facility-dashboard.mjs';
test('built facility tile uses the same health bands as its opening rows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'oi-bands-'));
 try{
  buildFacilityDashboard(dir);
  const html=readFileSync(join(dir,'index.html'),'utf8');
  const bands=html.match(/const BANDS=([\s\S]*?);/)[0];
  const unknown=html.match(/BANDS\.unknown=.*?;/)[0];
  const classify=html.match(/function bandOf\(s\)\{[^}]+\}/)[0];
  const tile=html.match(/var facilityBand=.*?;var sband=.*?;/)[0];
  for(const [score,complete,expected] of [[100,true,'Healthy'],[80,true,'Healthy'],[79,true,'Monitor'],[60,true,'Monitor'],[59,true,'Serious'],[40,true,'Serious'],[39,true,'Critical'],[0,true,'Critical'],[80,false,'Not assessed']]){
   const result=vm.runInNewContext(bands+unknown+classify+tile+'sband[0]',{score,complete,n:1});
   assert.equal(result,expected);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('recorded defects and unknown conditions cannot receive a no-action recommendation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'oi-priority-'));
 try{
  buildFacilityDashboard(dir);
  const html=readFileSync(join(dir,'index.html'),'utf8');
  const assessed=html.match(/function assessedScore\(p\)\{[^}]+\}/)[0];
  const opening=html.match(/function openingScore\(o\)\{[^}]+\}/)[0];
  const band=html.match(/function bandOf\(s\)\{[^}]+\}/)[0];
  const priority=html.match(/function openingPriorityBand\(o\)\{[\s\S]*?\n \}/)[0];
  for(const [server,conditions,expected] of [
   [80,[['good',100],['worn',68]],'monitor'],
   [95,[['failed',20]],'critical'],
   [45,[['good',100]],'serious'],
   [80,[['unverified',null]],'unknown'],
   [null,[['good',100]],'unknown'],
   [80,[['worn',68],['unverified',null]],'monitor'],
   [95,[['good',100]],'healthy'],
  ]){
   const o={parts:conditions.map(([condition,health_score])=>({condition,health_score,opening_health_score:server}))};
   const result=vm.runInNewContext(assessed+opening+band+priority+'[openingScore(o),openingPriorityBand(o)]',{o});
   assert.equal(result[0],server,'canonical score is preserved');
   assert.equal(result[1],expected);
  }
  assert.match(html,/var rec=recFor\(openingPriorityBand\(o\)\)/);
  assert.match(html,/includes\(openingPriorityBand\(o\)\)\)need\+\+/);
  assert.match(html,/Service-history health score/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
