#!/usr/bin/env node
/*
 * Handing is required before a door and frame record can be saved.
 *
 * Four checks, each driven through the interface:
 *
 *   blank_handing_is_refused        Save is pressed with handing left blank.
 *                                   Nothing is stored and the form says why.
 *   save_succeeds_with_handing      The same save, with a handing chosen, is
 *                                   accepted and stores that handing.
 *   handing_persists_after_reopen   The form is closed and reopened, and the
 *                                   stored handing comes back from the store,
 *                                   not from the fields left on screen.
 *   unrelated_openings_unchanged    A second opening's whole record is
 *                                   byte-identical before and after all of it.
 *
 * Every non-loopback request is aborted and counted. navigator.share is stubbed
 * and counted. No gate is staged or bypassed and nothing is dispatched.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const port = 8831, base = `http://127.0.0.1:${port}`;
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
                     { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let browser, blockedRequests = 0, attemptedDispatches = 0;
  const checks = {}, failures = [], evidence = {};
  async function check(name, action) {
    try { await action(); checks[name] = 'PASS'; }
    catch (error) { checks[name] = `FAIL: ${error.message}`; failures.push(`${name}: ${error.stack || error}`); }
  }
  try {
    await sleep(350);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 440, height: 900 } });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(base) || /^(data|blob|about):/.test(url)) return route.continue();
      blockedRequests += 1; return route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__attemptedDispatches = 0;
      navigator.share = async () => { window.__attemptedDispatches += 1; throw new Error('blocked'); };
    });
    await page.goto(`${base}/index.html?oi_local=1`, { waitUntil: 'load' });
    await sleep(1200);

    const setAttr = async (id, v) => { await page.selectOption(`#${id}`, v); await sleep(200); };
    const openDoor = async () => {
      const shown = await page.evaluate(() => {
        const f = document.getElementById('doorForm');
        return !!(f && getComputedStyle(f).display !== 'none');
      });
      if (!shown) { await page.click("button[onclick='window.toggleDoor()']"); await sleep(900); }
      await page.waitForSelector('#doorMat', { state: 'visible', timeout: 8000 });
    };
    const closeDoor = async () => {
      const shown = await page.evaluate(() => {
        const f = document.getElementById('doorForm');
        return !!(f && getComputedStyle(f).display !== 'none');
      });
      if (shown) { await page.click("button[onclick='window.toggleDoor()']"); await sleep(700); }
    };
    const doorOf = (op) => page.evaluate((o) => {
      const s = window.OIBounded.readStore(), f = window.oiActiveFacility();
      const x = s.openings[window.OIBounded.openingKey(f.id, o)];
      return x && x.door_frame ? JSON.parse(JSON.stringify(x.door_frame)) : null;
    }, op);
    const openingJson = (op) => page.evaluate((o) => {
      const s = window.OIBounded.readStore(), f = window.oiActiveFacility();
      return JSON.stringify(s.openings[window.OIBounded.openingKey(f.id, o)] || null);
    }, op);
    const savePart = async () => {
      const before = await page.evaluate(() => JSON.parse(localStorage.getItem('oi_log') || '[]').length);
      await page.click("button[onclick='logIt()']");
      await sleep(1200);
      const after = await page.evaluate(() => JSON.parse(localStorage.getItem('oi_log') || '[]').length);
      assert.equal(after, before + 1, 'saving did not add exactly one record');
    };

    // facility
    await page.click('#addFacBtn');
    await page.waitForSelector('#newFacName', { state: 'visible' });
    await page.fill('#newFacName', 'Valley Medical Center');
    await page.selectOption('#newFacType', 'Healthcare');
    await page.click('#createFacBtn');
    await sleep(2000);

    // ---- an UNRELATED opening, saved complete, with its own handing --------
    await page.fill('#loc', 'West corridor');
    await page.fill('#opnum', '400Z');
    await page.click('#classes button:has-text("LOCKSET")');
    await sleep(1200);
    await page.fill('#mq', 'ND80');
    await page.click("button[onclick='modelLookup()']");
    await page.waitForSelector('#mqres a', { timeout: 8000 }); await sleep(500);
    await page.locator('#mqres > div').filter({ hasText: 'ND80' }).first().locator('a').first().click();
    await sleep(1200);
    await setAttr('cond', 'good');
    await savePart();
    await openDoor();
    await setAttr('doorMat', 'Wood');
    await page.fill('#doorW', '36'); await page.fill('#doorH', '84'); await page.fill('#doorT', '1-3/4"');
    await setAttr('doorHand', 'RH');
    await setAttr('doorFrame', 'Hollow Metal');
    await page.click("button[onclick='window.saveDoor()']");
    await sleep(1600);
    const unrelatedBefore = await openingJson('400Z');
    evidence.unrelated_opening_handing = (await doorOf('400Z')).handing;
    assert.equal(evidence.unrelated_opening_handing, 'RH', 'the unrelated opening did not save its handing');
    await closeDoor();

    // ---- the opening under test -------------------------------------------
    await page.click("button[onclick='addPart()']");
    await sleep(900);
    await page.fill('#loc', 'North wing');
    await page.fill('#opnum', '310C');
    await page.click('#classes button:has-text("EXIT DEVICE")');
    await sleep(1200);
    await page.fill('#mq', 'AF7700');
    await page.click("button[onclick='modelLookup()']");
    await page.waitForSelector('#mqres a', { timeout: 8000 }); await sleep(500);
    await page.locator('#mqres > div').filter({ hasText: 'AF7700' }).first().locator('a').first().click();
    await sleep(1200);
    await setAttr('cond', 'worn');
    await savePart();

    await check('blank_handing_is_refused', async () => {
      await openDoor();
      await setAttr('doorMat', 'Hollow Metal');
      await page.fill('#doorW', '36'); await page.fill('#doorH', '84'); await page.fill('#doorT', '1-3/4"');
      await setAttr('doorFrame', 'Hollow Metal');
      await page.selectOption('#doorHand', '');            // explicitly blank
      assert.equal(await page.inputValue('#doorHand'), '', 'handing is not blank for this check');
      await page.click("button[onclick='window.saveDoor()']");
      await sleep(1400);
      const msg = (await page.textContent('#doorMsg') || '').trim();
      evidence.blank_message = msg;
      assert.match(msg, /handing/i, `the refusal does not mention handing: ${msg}`);
      assert.doesNotMatch(msg, /saved/i, `the form reported a save: ${msg}`);
      assert.equal(await doorOf('310C'), null, 'a door record was stored despite the refusal');
      // and the opening must not be finishable on the strength of it
      await page.click("button[onclick='window.finishOpening()']");
      await sleep(1400);
      const fin = (await page.textContent('#finishMsg') || '').trim();
      evidence.finish_after_refusal = fin;
      assert.doesNotMatch(fin, /is inspected, reviewed, saved and finished/i,
        `the opening finished without a door record: ${fin}`);
    });

    await check('save_succeeds_with_handing', async () => {
      await openDoor();
      await setAttr('doorHand', 'LH');
      await page.click("button[onclick='window.saveDoor()']");
      await sleep(1600);
      const msg = (await page.textContent('#doorMsg') || '').trim();
      evidence.saved_message = msg;
      assert.match(msg, /Door & frame saved to opening 310C/i, `save did not report success: ${msg}`);
      const d = await doorOf('310C');
      evidence.saved_door = d;
      assert.ok(d, 'no door record was stored');
      assert.equal(d.handing, 'LH', `stored handing is ${JSON.stringify(d.handing)}`);
      assert.equal(d.material, 'Hollow Metal');
      assert.equal(d.width_in, '36');
      assert.equal(d.height_in, '84');
      assert.equal(d.frame, 'Hollow Metal');
    });

    await check('handing_persists_after_reopen', async () => {
      await closeDoor();
      // the fields are cleared on close, so what comes back is the store's
      const cleared = await page.evaluate(() => (document.getElementById('doorHand') || {}).value);
      evidence.handing_field_after_close = cleared;
      await openDoor();
      const shown = await page.evaluate(() => (document.getElementById('doorHand') || {}).value);
      evidence.handing_field_after_reopen = shown;
      assert.equal(shown, 'LH', `the reopened form shows handing ${JSON.stringify(shown)}`);
      const d = await doorOf('310C');
      assert.equal(d.handing, 'LH', 'the stored handing changed on reopen');
      // and it survives a reload of the page itself
      await page.reload({ waitUntil: 'load' });
      await sleep(1500);
      const afterReload = await page.evaluate(() => {
        const s = window.OIBounded.readStore();
        const key = Object.keys(s.openings).find((k) => k.endsWith('310C'));
        return key ? s.openings[key].door_frame.handing : null;
      });
      evidence.handing_after_reload = afterReload;
      assert.equal(afterReload, 'LH', 'the handing did not survive a reload');
    });

    await check('unrelated_openings_unchanged', async () => {
      const after = await openingJson('400Z');
      evidence.unrelated_unchanged = after === unrelatedBefore;
      assert.equal(after, unrelatedBefore,
        'the unrelated opening record changed while 310C was being corrected');
    });

    attemptedDispatches += await page.evaluate(() => window.__attemptedDispatches || 0);
    if (blockedRequests) failures.push(`blocked_requests: expected 0, got ${blockedRequests}`);
    if (attemptedDispatches) failures.push(`attempted_dispatches: expected 0, got ${attemptedDispatches}`);
    console.log(JSON.stringify({
      status: failures.length ? 'FAIL' : 'PASS', ...checks,
      blocked_requests: blockedRequests, attempted_dispatches: attemptedDispatches, evidence,
    }, null, 2));
    if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
