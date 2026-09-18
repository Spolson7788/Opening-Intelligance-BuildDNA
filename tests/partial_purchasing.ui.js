#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const port = 8819, base = `http://127.0.0.1:${port}`;
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let browser, blockedRequests = 0, attemptedDispatches = 0;
  const checks = {}, failures = [];
  async function check(name, action) {
    try { await action(); checks[name] = 'PASS'; }
    catch (error) { checks[name] = `FAIL: ${error.message}`; failures.push(`${name}: ${error.stack || error}`); }
  }
  try {
    await sleep(350);
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

    await page.evaluate(() => {
      const facility = { id: 'facility-b', name: 'Valley Medical Center' };
      localStorage.setItem('oi_facilities', JSON.stringify([facility]));
      localStorage.setItem('oi_active_facility_id', facility.id);
      window.OI_ACTIVE_FACILITY = facility;
      window.OIProviderMappings.importCsv(localStorage, 'service-provider', [
        'manufacturer,product_model,provider_sku,product_description,configuration_details',
        'Cal-Royal,CR441,ED-13282,CR441 complete closer with hold-open arm,hold_open',
        'Cal-Royal,AF7700,SWFD-10183,AF7700 Exit Device,',
      ].join('\n'));
      const closer = {
        component_id: 'closer-205a', facility_id: facility.id, facility_name: facility.name,
        opnum: '205A', loc: 'First opening', CLASS: 'DOOR_CLOSER', cond: 'worn',
        saved_at: '2026-09-19T00:00:00Z', reviewed_at: '2026-09-19T00:00:00Z',
        how_established: 'unresolved', gate_product: null,
      };
      const exitDevice = {
        component_id: 'af-310c', facility_id: facility.id, facility_name: facility.name,
        opnum: '310C', loc: 'North wing', CLASS: 'EXIT_DEVICE', cond: 'worn',
        saved_at: '2026-09-19T00:00:00Z', reviewed_at: '2026-09-19T00:00:00Z',
        how_established: 'technician selected',
        gate_product: { manufacturer: 'Cal-Royal', model: 'AF7700', cut_sheet_url: 'https://example.invalid/af7700.pdf' },
      };
      window.LOG = [closer, exitDevice];
      localStorage.setItem('oi_log', JSON.stringify(window.LOG));
      window.OIBounded.writeStore({ version: 1, openings: {
        [window.OIBounded.openingKey(facility.id, '205A')]: {
          facility_id: facility.id, opening_no: '205A', finished: true,
          door_frame: { material: 'Hollow Metal' }, components: [closer],
        },
        [window.OIBounded.openingKey(facility.id, '310C')]: {
          facility_id: facility.id, opening_no: '310C', finished: true,
          door_frame: { material: 'Hollow Metal' }, components: [exitDevice],
        },
      }});
    });

    const beforeStore = await page.evaluate(() => localStorage.getItem('oi_bounded_workflow_v1'));
    await page.evaluate(() => window.oiRenderActions());
    await page.evaluate(() => window.sendLogToPurchasing());

    await check('eligible_310c_remains_orderable', async () => {
      const payload = await page.textContent('#oiPurchasePayload');
      assert.match(payload, /Opening 310C/);
      assert.match(payload, /Cal-Royal AF7700/);
      assert.match(payload, /SWFD-10183/);
    });
    await check('unresolved_205a_is_excluded', async () => {
      const payload = await page.textContent('#oiPurchasePayload');
      assert.match(payload, /Excluded from this request — follow-up required/);
      assert.match(payload, /Opening 205A door closer/);
      assert.match(payload, /replacement identity is not gate-approved/);
      assert.doesNotMatch(payload, /ED-13282/);
    });
    await check('acknowledgment_required_before_dispatch', async () => {
      assert.equal(await page.isVisible('#oiPurchaseAcknowledgeWrap'), true);
      assert.match(await page.textContent('#oiBulkGateReason'), /1 item is excluded and requires acknowledgment and follow-up/);
      assert.match(await page.textContent('#oiPurchaseExclusions'), /1 item is excluded from this request and remains open/);
      assert.equal(await page.isDisabled('#oiPurchaseDispatch'), true);
      await page.check('#oiPurchaseAcknowledge');
      assert.equal(await page.isDisabled('#oiPurchaseDispatch'), false);
    });
    await check('unresolved_follow_up_preserved', async () => {
      assert.equal(await page.evaluate(() => localStorage.getItem('oi_bounded_workflow_v1')), beforeStore);
      const decision = await page.evaluate(() => window.OI_LAST_PURCHASE_DECISION);
      assert.equal(decision.blocked.length, 1);
      assert.equal(decision.blocked[0].followUpRequired, true);
      assert.equal(decision.blocked[0].record.component_id, 'closer-205a');
    });
    attemptedDispatches += await page.evaluate(() => window.__attemptedDispatches || 0);
    if (blockedRequests) failures.push(`blocked_requests: expected 0, got ${blockedRequests}`);
    if (attemptedDispatches) failures.push(`attempted_dispatches: expected 0, got ${attemptedDispatches}`);
    console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', ...checks, blocked_requests: blockedRequests, attempted_dispatches: attemptedDispatches }, null, 2));
    if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
