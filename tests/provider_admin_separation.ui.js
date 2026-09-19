#!/usr/bin/env node
/*
 * Provider mapping import is administrator / onboarding work, separated from
 * the field technician's workflow.
 *
 * The six points, each driven through supported UI:
 *
 *   administrator_can_import            an authorized administrator imports the
 *                                       mapping on the admin interface.
 *   mapping_persists_and_resolves       it survives a full page load and
 *                                       resolves AF7700 -> SWFD-10183.
 *   technician_has_no_import_controls   the technician page contains no file
 *                                       input and no mapping-import control,
 *                                       and never loads the import code.
 *   technician_sees_only_the_sku        the technician sees the resulting SKU
 *                                       where purchasing review uses it.
 *   mapping_does_not_establish_identity an unresolved part stays unresolved and
 *                                       excluded, mapping or no mapping.
 *   unauthorized_cannot_import          without an administrator session the
 *                                       import controls are not in the page and
 *                                       the import refuses when driven directly.
 *
 * Every non-loopback request is aborted and counted. navigator.share is stubbed
 * and counted. No gate is staged or bypassed and nothing is dispatched.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 8833, base = `http://127.0.0.1:${port}`;
const FIXTURE = path.join(root, 'tests/fixtures/service_provider_mappings.csv');
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
                     { cwd: root, stdio: 'ignore' });
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

    // ---- 6 · an unauthorized visitor to the ADMIN page ---------------------
    await page.goto(`${base}/provider-admin.html?oi_local=1`, { waitUntil: 'load' });
    await sleep(700);
    await check('unauthorized_cannot_import', async () => {
      assert.equal(await page.isVisible('#providerMappingDenied'), true,
        'the refusal is not shown to an unauthorized visitor');
      assert.equal(await page.isVisible('#providerMappingCard'), false,
        'the import card is visible without an administrator session');
      assert.equal(await page.isVisible('#providerMappingFile'), false,
        'a file input is reachable without an administrator session');
      assert.equal(await page.evaluate(() => window.OIProviderAdmin.isAuthorized()), false);
      // there must be no exported way to become an administrator
      const surface = await page.evaluate(() => Object.keys(window.OIProviderAdmin));
      evidence.admin_surface = surface;
      assert.deepEqual(surface.sort(), ['isAuthorized', 'render'],
        `the admin module exports more than a query: ${JSON.stringify(surface)}`);
      // and driving the import directly, without the grant, refuses
      const forced = await page.evaluate(() => {
        const b = document.getElementById('providerMappingImport');
        if (!b) return 'no control in the page at all';
        b.click();
        return (document.getElementById('providerMappingMsg') || {}).textContent || '';
      });
      evidence.unauthorized_direct_attempt = forced;
      const stored = await page.evaluate(() =>
        localStorage.getItem('oi_provider_mappings_v1'));
      assert.equal(stored, null, 'a mapping was stored without authorization');
    });

    // ---- 1 · an authorized administrator imports ---------------------------
    await check('administrator_can_import', async () => {
      assert.ok(fs.existsSync(FIXTURE), 'the mapping fixture is missing');
      await page.click('#providerAdminSignin');
      await sleep(700);
      assert.equal(await page.evaluate(() => window.OIProviderAdmin.isAuthorized()), true,
        'the administrator session was not established');
      assert.equal(await page.isVisible('#providerMappingCard'), true,
        'the import card did not appear for an administrator');
      evidence.admin_who = (await page.textContent('#providerAdminWho') || '').trim();
      await page.setInputFiles('#providerMappingFile', FIXTURE);
      await sleep(400);
      await page.click('#providerMappingImport');
      await sleep(1200);
      const msg = (await page.textContent('#providerMappingMsg') || '').trim();
      evidence.import_message = msg;
      assert.match(msg, /saved for the service provider/, `import did not succeed: ${msg}`);
    });

    // ---- 2 · it persists and resolves --------------------------------------
    await check('mapping_persists_and_resolves', async () => {
      await page.goto(`${base}/provider-admin.html`, { waitUntil: 'load' });
      await sleep(700);
      const rows = await page.evaluate(() =>
        (window.OIProviderMappings.read(localStorage).providers['service-provider'] || [])
          .map((r) => ({ model: r.product_model, sku: r.provider_sku })));
      evidence.stored_after_reload = rows;
      assert.equal(rows.length, 2, 'the mappings did not survive a full page load');
      const hit = await page.evaluate(() => window.OIProviderMappings.lookup(
        localStorage, 'service-provider',
        { manufacturer: 'Cal-Royal', model: 'AF7700', configuration_details: '' }));
      evidence.af7700_lookup = hit && hit.mapping ? hit.mapping.provider_sku : hit;
      assert.equal(evidence.af7700_lookup, 'SWFD-10183',
        `AF7700 resolved to ${JSON.stringify(evidence.af7700_lookup)}`);
    });

    // ---- 3 · the technician page carries no import controls ----------------
    await check('technician_has_no_import_controls', async () => {
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      for (const id of ['providerMappingCard', 'providerMappingFile',
                        'providerMappingImport', 'providerMappingMsg']) {
        assert.ok(!html.includes('id="' + id + '"'),
          `index.html still contains #${id}`);
      }
      assert.ok(!html.includes('oi-provider-admin.js'),
        'the technician page loads the administrator import code');
      const bundle = fs.readFileSync(path.join(root, 'oi-bounded-workflow.js'), 'utf8');
      assert.ok(!bundle.includes('providerMapping'),
        'the technician bundle still carries import-control code');

      await page.goto(`${base}/index.html?oi_local=1`, { waitUntil: 'load' });
      await sleep(1200);
      const found = await page.evaluate(() => ({
        byId: ['providerMappingCard', 'providerMappingFile', 'providerMappingImport']
          .filter((id) => !!document.getElementById(id)),
        // The two photograph inputs are the technician's own capture controls
        // and must stay. What must not exist is any file input that accepts a
        // data file — a mapping CSV — rather than an image.
        photoInputs: [...document.querySelectorAll('input[type=file]')]
          .filter((e) => /image/.test(e.getAttribute('accept') || '')).map((e) => e.id),
        nonImageFileInputs: [...document.querySelectorAll('input[type=file]')]
          .filter((e) => !/image/.test(e.getAttribute('accept') || ''))
          .map((e) => e.id || e.outerHTML.slice(0, 80)),
        importText: [...document.querySelectorAll('button,summary')]
          .filter((e) => /import/i.test(e.textContent || '')).map((e) => e.textContent.trim()),
        adminModule: typeof window.OIProviderAdmin,
      }));
      evidence.technician_page = found;
      assert.deepEqual(found.byId, [], `import controls present: ${JSON.stringify(found.byId)}`);
      assert.deepEqual(found.nonImageFileInputs, [],
        `the technician page exposes a non-image file input: ${JSON.stringify(found.nonImageFileInputs)}`);
      assert.deepEqual(found.photoInputs, ['photo', 'photolib'],
        `the photograph capture controls changed: ${JSON.stringify(found.photoInputs)}`);
      assert.deepEqual(found.importText, [],
        `an import control is on screen: ${JSON.stringify(found.importText)}`);
      assert.equal(found.adminModule, 'undefined',
        'the administrator module is loaded on the technician page');
    });

    // ---- build the demonstration state on the technician page --------------
    const setAttr = async (id, v) => { await page.selectOption(`#${id}`, v); await sleep(200); };
    const savePart = async () => {
      const before = await page.evaluate(() => JSON.parse(localStorage.getItem('oi_log') || '[]').length);
      await page.click("button[onclick='logIt()']");
      await sleep(1200);
      const after = await page.evaluate(() => JSON.parse(localStorage.getItem('oi_log') || '[]').length);
      assert.equal(after, before + 1, 'saving did not add exactly one record');
    };
    const openDoor = async () => {
      const shown = await page.evaluate(() => {
        const f = document.getElementById('doorForm');
        return !!(f && getComputedStyle(f).display !== 'none');
      });
      if (!shown) { await page.click("button[onclick='window.toggleDoor()']"); await sleep(900); }
      await page.waitForSelector('#doorMat', { state: 'visible', timeout: 8000 });
    };
    const doorAndFinish = async (hand) => {
      await openDoor();
      await setAttr('doorMat', 'Hollow Metal');
      await page.fill('#doorW', '36'); await page.fill('#doorH', '84'); await page.fill('#doorT', '1-3/4"');
      await setAttr('doorHand', hand);
      await setAttr('doorFrame', 'Hollow Metal');
      await page.click("button[onclick='window.saveDoor()']");
      await sleep(1600);
      await page.click("button[onclick='window.finishOpening()']");
      await sleep(1800);
      return (await page.textContent('#finishMsg') || '').trim();
    };

    await page.click('#addFacBtn');
    await page.waitForSelector('#newFacName', { state: 'visible' });
    await page.fill('#newFacName', 'Valley Medical Center');
    await page.selectOption('#newFacType', 'Healthcare');
    await page.click('#createFacBtn');
    await sleep(2000);

    // 205A — an unresolved worn closer
    await page.fill('#loc', 'First opening');
    await page.fill('#opnum', '205A');
    await page.click('#classes button:has-text("DOOR CLOSER")');
    await sleep(1200);
    await setAttr('a_closer_type', 'surface');
    await setAttr('mfr', 'Cal-Royal');
    await sleep(1000);
    await setAttr('cond', 'worn');
    await savePart();
    await doorAndFinish('LH');

    // 310C — the reviewed, worn AF7700
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
    await doorAndFinish('LH');

    // ---- 4 · the technician sees only the resulting SKU --------------------
    await check('technician_sees_only_the_sku', async () => {
      await page.evaluate(() => window.oiRenderActions());
      await page.evaluate(() => window.sendLogToPurchasing());
      await sleep(900);
      const payload = await page.textContent('#oiPurchasePayload');
      evidence.review_sku_line = payload.split('\n').find((l) => /SKU/i.test(l));
      assert.match(payload, /SWFD-10183/, 'the review does not carry the provider SKU');
      assert.match(payload, /Cal-Royal AF7700/);
      assert.match(payload, /Opening 310C/);
      assert.doesNotMatch(payload, /ED-13282/, 'the closer SKU attached to this request');
      const status = await page.textContent('#oiPurchaseStatus');
      assert.match(status, /nothing has been sent/i);
      // and still no import control anywhere, review open
      const ctrls = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')]
        .filter((e) => !/image/.test(e.getAttribute('accept') || '')).map((e) => e.id));
      assert.deepEqual(ctrls, [],
        `a non-image file input appeared once the review was open: ${JSON.stringify(ctrls)}`);
    });

    // ---- 5 · the mapping does not establish identity -----------------------
    await check('mapping_does_not_establish_identity', async () => {
      const decision = await page.evaluate(() => window.OI_LAST_PURCHASE_DECISION);
      evidence.blocked = decision.blocked.map((b) => ({ label: b.label, reasons: b.reasons }));
      assert.equal(decision.blocked.length, 1, 'the unresolved closer is not excluded');
      assert.match(decision.blocked[0].label, /205A door closer/);
      assert.match(decision.blocked[0].reasons.join(' '), /identity is not gate-approved/);
      // a mapping exists for CR441, and it changes nothing about the closer
      const cr = await page.evaluate(() => window.OIProviderMappings.lookup(
        localStorage, 'service-provider',
        { manufacturer: 'Cal-Royal', model: 'CR441', configuration_details: 'hold_open' }));
      evidence.cr441_mapping_exists = !!(cr && cr.mapping);
      assert.equal(evidence.cr441_mapping_exists, true,
        'the CR441 mapping is absent, so this check proves nothing');
      const payload = await page.textContent('#oiPurchasePayload');
      assert.doesNotMatch(payload, /ED-13282/,
        'a mapping put an ordering number against an unresolved part');
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
