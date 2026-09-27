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
