#!/usr/bin/env node
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');
const port = 8811, base = `http://127.0.0.1:${port}`;
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let browser, blockedRequests = 0;
  const results = {}, failures = [];
  async function check(name, action) {
    try { await action(); results[name] = 'PASS'; }
    catch (error) { results[name] = `FAIL: ${error.message}`; failures.push(`${name}: ${error.stack || error}`); }
  }
  async function isolatedPage() {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) await route.continue();
      else { blockedRequests += 1; await route.abort(); }
    });
    const page = await context.newPage();
    await page.goto(`${base}/index.html?oi_local=1`, { waitUntil: 'load' });
    return { context, page };
  }
  try {
    await sleep(750);
    browser = await chromium.launch({ headless: true });

    // Isolated so a failure cannot mask the persistence and result-card checks.
    const missing = await isolatedPage();
    await check('missing_facility_refusal', async () => {
      await missing.page.click('#svcToggleBtn');
      await missing.page.fill('#opnum', '310B');
      await missing.page.fill('#svcSymptom', 'Door will not latch');
      await missing.page.click('#svcSaveBtn');
      assert.match(await missing.page.textContent('#svcMsg'), /Pick a facility first/);
      assert.equal(await missing.page.evaluate(() => localStorage.getItem('oi_local_service_requests')), null);
    });
    await missing.context.close();

    const main = await isolatedPage(), page = main.page;
    await page.click('#addFacBtn');
    await page.fill('#newFacName', 'Valley Medical Center');
    await page.selectOption('#newFacType', 'Healthcare');
    await page.click('#createFacBtn');
    await page.waitForFunction(() => window.OI_ACTIVE_FACILITY && window.OI_ACTIVE_FACILITY.name === 'Valley Medical Center');
    const facility = await page.evaluate(() => window.OI_ACTIVE_FACILITY);
    await page.selectOption('#facSel', facility.id);
    await page.dispatchEvent('#facSel', 'change');

    const openingFixture = { version: 1, openings: {} };
    openingFixture.openings[`${encodeURIComponent(facility.id)}::310B`] = {
      id: 'local-opening-310B', facility_id: facility.id, facility_name: facility.name,
      opening_no: '310B', area: 'West corridor', finished: true,
      finished_at: '2026-09-18T00:00:00.000Z', local_only: true,
      door_frame: { material: 'steel', width: '36', height: '84', thickness: '1 3/4', handing: 'RH', frame: 'hollow metal' },
      components: [{ component_id: 'component-nd80', CLASS: 'LOCKSET', manufacturer: 'Schlage', model: 'ND80', condition: 'serviceable' }],
    };
    await page.evaluate((fixture) => localStorage.setItem('oi_bounded_workflow_v1', JSON.stringify(fixture)), openingFixture);
    const before = await page.evaluate(() => localStorage.getItem('oi_bounded_workflow_v1'));

    // Independent of the service-save path.
    await check('result_card_evidence_request', async () => {
      await page.locator('#classes button', { hasText: 'LOCKSET' }).first().click();
      await page.selectOption('#a_lock_type', 'cylindrical');
      await page.selectOption('#a_trim', 'lever');
      await page.selectOption('#a_rose_shape', 'round');
      await page.selectOption('#a_keyed', 'yes');
      await page.selectOption('#a_function', 'storeroom');
      await page.locator('#form button').first().click();
      const text = await page.textContent('#result');
      assert.match(text, /Photograph any stamped model number, label, casting mark or logo on the body/);
      assert.match(text, /A readable marking may provide additional evidence for the manufacturer, family or model/);
      assert.doesNotMatch(text, /eight closers|only feature/i);
    });

    await page.click('#svcToggleBtn');
    await page.fill('#opnum', '310B');
    await page.fill('#svcSymptom', 'Door will not latch');
    await page.fill('#svcCost', '180');
    await check('cost_reference_refusal', async () => {
      await page.click('#svcSaveBtn');
      assert.match(await page.textContent('#svcMsg'), /cost needs its work order or invoice reference/i);
      assert.equal(await page.evaluate(() => localStorage.getItem('oi_local_service_requests')), null);
    });

    await check('successful_save_and_reload', async () => {
      await page.fill('#svcCostRef', 'WO-2026-1184');
      await page.fill('#svcWork', 'Latch assembly replaced; door and frame alignment corrected');
      await page.click('#svcSaveBtn');
      await page.waitForFunction(() => /Saved against 310B/.test(document.getElementById('svcMsg').textContent));
      const saved = await page.evaluate(() => ({ requests: JSON.parse(localStorage.getItem('oi_local_service_requests') || '[]'), events: JSON.parse(localStorage.getItem('oi_local_service_events') || '[]') }));
      assert.equal(saved.requests.length, 1); assert.equal(saved.events.length, 1);
      assert.equal(saved.requests[0].facility_id, facility.id); assert.equal(saved.requests[0].opening_no, '310B');
      assert.equal(saved.events[0].cost, 180); assert.equal(saved.events[0].cost_evidence, 'WO-2026-1184');
      await page.reload({ waitUntil: 'load' });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('oi_local_service_requests') || '[]').length), 1);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('oi_local_service_events') || '[]').length), 1);
    });
    await check('existing_opening_unchanged', async () => assert.equal(await page.evaluate(() => localStorage.getItem('oi_bounded_workflow_v1')), before));
    await main.context.close();

    if (blockedRequests !== 0) failures.push(`blocked_requests: expected 0, got ${blockedRequests}`);
    console.log(JSON.stringify({
      status: failures.length ? 'FAIL' : 'PASS', facility,
      missing_facility_refusal: results.missing_facility_refusal,
      cost_reference_refusal: results.cost_reference_refusal,
      successful_save_and_reload: results.successful_save_and_reload,
      existing_opening_unchanged: results.existing_opening_unchanged,
      result_card_evidence_request: results.result_card_evidence_request,
      blocked_requests: blockedRequests,
    }, null, 2));
    if (failures.length) { console.error('\n' + failures.join('\n\n')); process.exitCode = 1; }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
