import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {formatCalendarDate} from '../site/connected.mjs';
test('Service calendar day stays September 21 in Phoenix and other time zones',()=>{
  const moduleUrl=new URL('../site/connected.mjs',import.meta.url).href;
  for(const TZ of ['America/Phoenix','America/Los_Angeles','UTC','Pacific/Kiritimati']){
    const code=`import {formatCalendarDate} from ${JSON.stringify(moduleUrl)};process.stdout.write(formatCalendarDate('2026-09-21','en-US'));`;
    assert.equal(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ},encoding:'utf8'}),'9/21/2026',TZ);
  }
});
test('Missing and impossible calendar dates remain explicit',()=>{
  for(const date of [null,'','2026-02-30','invalid','2026-09-21T00:00:00Z'])assert.equal(formatCalendarDate(date,'en-US'),'Date unavailable');
  assert.equal(formatCalendarDate('2024-02-29','en-US'),'2/29/2024');
});
