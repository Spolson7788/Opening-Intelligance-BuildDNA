#!/usr/bin/env node
/* Isolated UI acceptance for link-source facility selection and authorization. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');
const port = 8817, base = `http://127.0.0.1:${port}`;
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let browser, blockedRequests = 0, attemptedDispatches = 0;
  const checks = {}, failures = [], evidence = {};
  async function check(name, action) {
    try { await action(); checks[name] = 'PASS'; }
    catch (error) { checks[name] = `FAIL: ${error.message}`; failures.push(`${name}: ${error.stack || error}`); }
  }
  try {
    await sleep(500);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(base) || /^(data|blob|about):/.test(url)) return route.continue();
      blockedRequests += 1; return route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__attemptedDispatches = 0;
      navigator.share = async () => { window.__attemptedDispatches += 1; throw new Error('test blocked dispatch'); };
    });
    await page.goto(`${base}/index.html?oi_local=1`, { waitUntil: 'load' });

    async function addFacility(name) {
      await page.click('#addFacBtn');
      await page.fill('#newFacName', name);
      await page.selectOption('#newFacType', 'Healthcare');
      await page.click('#createFacBtn');
      await page.waitForFunction((wanted) => document.querySelector('#facSel option:checked')?.textContent === wanted, name);
      return page.$eval('#facSel', (select) => select.value);
    }
    const facilityA = await addFacility('Facility A');
    const facilityB = await addFacility('Facility B');
    await page.selectOption('#facSel', facilityA);
    await page.dispatchEvent('#facSel', 'change');
    await page.evaluate(({ facilityB }) => {
      const rows = JSON.parse(localStorage.getItem('oi_local_openings') || '[]');
      rows.push({ facility_id: facilityB, opening_no: 'B-101', component_class: 'EXIT_DEVICE', manufacturer: 'Cal-Royal', model: 'AF7700', condition: 'worn' });
      localStorage.setItem('oi_local_openings', JSON.stringify(rows));
    }, { facilityB });

    await check('authorized_link_selects_facility_B', async () => {
      await page.evaluate(({ facilityB }) => { location.hash = `o=${encodeURIComponent(facilityB)}~B-101`; }, { facilityB });
      await page.waitForSelector('#recOverlay', { state: 'visible' });
      const state = await page.evaluate(() => ({ active: window.OI_ACTIVE_FACILITY, selected: document.getElementById('facSel').value, text: document.getElementById('recBody').innerText }));
      evidence.authorized_link = state;
      assert.equal(state.active.id, facilityB);
      assert.equal(state.selected, facilityB);
      assert.match(state.text, /Cal-Royal AF7700/);
    });

    await check('service_save_uses_facility_B', async () => {
      const openingBefore = await page.evaluate(() => localStorage.getItem('oi_local_openings'));
      await page.click('#recBody button:has-text("Log a service call")');
      await page.click('#svcToggleBtn');
      await page.fill('#svcSymptom', 'Demonstration complaint');
      await page.click('#svcSaveBtn');
      await page.waitForFunction(() => /Saved against B-101/.test(document.getElementById('svcMsg').textContent));
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('oi_local_service_requests') || '[]'));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].facility_id, facilityB);
      assert.equal(saved[0].opening_no, 'B-101');
      assert.equal(await page.evaluate(() => localStorage.getItem('oi_local_openings')), openingBefore, 'viewing/saving service call changed installed opening rows');
    });

    await check('unauthorized_link_is_refused', async () => {
      await page.evaluate(() => { location.hash = 'o=unauthorized-facility~NO-1'; });
      await page.waitForFunction(() => /not authorized/.test(document.getElementById('recBody').innerText));
      assert.equal(await page.evaluate(() => window.OI_ACTIVE_FACILITY.id), facilityB, 'refused link changed the active facility');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('oi_local_service_requests') || '[]').length), 1);
    });
    attemptedDispatches += await page.evaluate(() => window.__attemptedDispatches || 0);
    if (blockedRequests) failures.push(`blocked_requests: expected 0, got ${blockedRequests}`);
    if (attemptedDispatches) failures.push(`attempted_dispatches: expected 0, got ${attemptedDispatches}`);
    console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', ...checks, blocked_requests: blockedRequests, attempted_dispatches: attemptedDispatches, evidence }, null, 2));
    if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
