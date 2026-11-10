import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { buildFacilityDashboard } from './build-facility-dashboard.mjs';
import { apiFunctionView, apiRoutesOk, assertPublishableDeploy, assertSite, assertStagingApiPath, checkLocalLookups, classifyUploadResponse, compareDeploySnapshots, diffReady, fileDigestKey, fileUploadPath, functionConfigFromBuild, functionInvocationMode, functionUploadHeaders, functionUploadQuery, functionsZipConfig, includeNetlifyToml, functionShasToUpload, invocationStampComment, loginProbeReached, needsPublishingLock, productionDeployBody, publishBlocker, publishReadyDeploy, publishWithoutUpload, readyPublishSteps, rollbackTarget, scrubDeployValue, selectPublishSnapshot, selectUploadSnapshot, snapshotFromResponses, compareFunctionLists, functionZipProblems, eagerNativePackagingProblems, eagerNativeProblemsForZip, linuxSharpPackagingProblems, linuxSharpVersions, stageLinuxSharp, linuxSharpZipEntries, appendZipEntries, extractZip, zipUnzippedBytes, API_ZIP_MAX_UNZIPPED_BYTES, listZipEntryNames, readZipEntry, functionsFromDeploy, missingBundledModules, stageFunctionSources, packageCommitAllowed, packageChecksum, PRODUCTION_SITE_ID, STAGING_SITE_ID, STAGING_SITE_NAME, STAGING_URL, PINNED_COMMIT, envNamesFromPayload, recognitionEnvReport, measurementReaderReport, measurementReaderEnvBody, siteEnvReport, MEASUREMENT_READER_KEY, accountIdFromSite, accountEnvPath, measurementReaderAlreadySet } from './artifact-publisher-staging-16abbf4.mjs';

test('diagnose compares function metadata without keeping secrets', () => {
  const knownGood = functionsFromDeploy({ available_functions: [{ n: 'api', d: 'sha-good', runtime: 'nodejs22.x', im: 'stream', ro: [], a: 100 }] });
  const candidate = functionsFromDeploy({
    available_functions: [{ n: 'api', d: 'sha-bad', runtime: 'nodejs22.x', im: 'stream', ro: [], a: 528289, authorization: 'Bearer secret-token' }],
    functions_config: { api: { routes: [{ pattern: '/health' }, { pattern: '/api/*' }] } },
  });
  const differences = compareFunctionLists(knownGood, candidate);
  const api = differences.find((item) => item.name === 'api');
  assert.equal(api.fields.sha.knownGood, 'sha-good');
  assert.equal(api.fields.size.candidate, 528289);
  assert.deepEqual(candidate[0].routes, ['/health', '/api/*']);
  assert.equal(JSON.stringify(differences).includes('secret-token'), false);
});

test('staging site is the only accepted target', () => {
  assert.deepEqual(assertSite({ id: STAGING_SITE_ID, name: STAGING_SITE_NAME, url: STAGING_URL }), {
    id: STAGING_SITE_ID, name: STAGING_SITE_NAME, url: STAGING_URL,
  });
});

test('production and any other site are refused', () => {
  assert.throws(() => assertSite({ id: PRODUCTION_SITE_ID, name: 'oi-production', url: 'https://oi-production.netlify.app' }), /refusing_production/);
  assert.throws(() => assertSite({ id: '80fbbee8-b9d3-4b16-b93f-d2d8396591ec', name: 'oi-connected-release-candidate', url: 'https://oi-connected-release-candidate.netlify.app' }), /refusing_site_mismatch/);
  assert.equal(PINNED_COMMIT, 'b85f44dd5d90928b88b4dcc3a9d2b987e352d644');
  assert.equal(packageCommitAllowed(PINNED_COMMIT), true);
  assert.equal(packageCommitAllowed('16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5'), false);
  assert.equal(packageCommitAllowed('9c0256e1b92182a55246bc7e6460ab456098a48d'), false);
  const files = { 'publish/index.html': { sha256: 'abc', bytes: 3 } };
  const recorded = packageChecksum(PINNED_COMMIT, files);
  assert.equal(packageChecksum(PINNED_COMMIT, files), recorded);
  assert.notEqual(packageChecksum('16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5', files), recorded);
  assert.equal(assertStagingApiPath(`/api/v1/sites/${STAGING_SITE_ID}`), `/api/v1/sites/${STAGING_SITE_ID}`);
  assert.throws(() => assertStagingApiPath(`/api/v1/sites/${PRODUCTION_SITE_ID}`), /refusing_production/);
  assert.throws(() => assertStagingApiPath('/api/v1/deploys/other/files/index.html', 'ours'), /refusing_site_mismatch/);
});

test('required file sha1 and function sha256 both resolve', () => {
  const fileSha = 'a'.repeat(40);
  const functionSha = 'b'.repeat(64);
  const fileMap = { files: { 'index.html': fileSha }, byHash: { [fileSha]: [{ rel: 'index.html', path: 'index.html' }] } };
  const functionMap = { functions: { api: functionSha }, byHash: { [functionSha]: [{ name: 'api', path: 'api.zip', runtime: 'js' }] } };
  assert.deepEqual(checkLocalLookups(fileMap, functionMap), []);
  assert.equal(fileMap.byHash[fileSha][0].rel, 'index.html');
  assert.equal(functionMap.byHash[functionSha][0].name, 'api');
  assert.equal(fileDigestKey('index.html'), '/index.html');
  assert.equal(fileDigestKey('/field/index.html'), '/field/index.html');
  assert.equal(fileUploadPath('abc', '/index.html'), '/api/v1/deploys/abc/files/index.html');
  assert.equal(diffReady({ state: 'uploading', required: [], required_functions: [] }), true);
  const preparing = { state: 'preparing', required: [], required_functions: ['f1d3799c'] };
  assert.equal(diffReady(preparing), false);
  assert.equal(selectUploadSnapshot([preparing, { state: 'prepared', required: [], required_functions: ['f1d3799c'] }]).state, 'prepared');
  const prepared = { state: 'prepared', required: ['646641cc', '4b841fe6', '34618751', '5ae24228'], required_functions: [] };
  assert.equal(diffReady(prepared), true);
  assert.equal(selectUploadSnapshot([{ state: 'preparing', required: [], required_functions: [] }, prepared]), prepared);
  const deduped = { state: 'ready', required: [], required_functions: [] };
  assert.equal(publishWithoutUpload(deduped), true);
  assert.equal(publishWithoutUpload({ state: 'prepared', required: [], required_functions: [] }), true);
  assert.equal(publishWithoutUpload(prepared), false);
  assert.equal(selectUploadSnapshot([{ state: 'preparing', required: [] }, deduped]), deduped);
  assert.deepEqual(readyPublishSteps(deduped), ['restore', 'confirm-published']);
  assert.deepEqual(readyPublishSteps(prepared), ['upload', 'wait-ready', 'restore', 'confirm-published']);
  assert.deepEqual(readyPublishSteps(preparing), ['wait-prepared', 'upload', 'wait-ready', 'restore', 'confirm-published']);
  const api = functionConfigFromBuild({ name: 'api', routes: ['/health', '/api/*'], displayName: 'API', generator: '@netlify/functions', schedule: '0 0 * * *' });
  assert.deepEqual(api.routes, ['/health', '/api/*']);
  assert.equal(api.display_name, 'API');
  assert.equal(apiRoutesOk({ functionsConfig: { api } }), true);
  assert.equal(apiRoutesOk({ functionsConfig: { api: { routes: ['/health'] } } }), false);
  const zisiRoutes = [
    { pattern: '/health', literal: '/health' },
    { pattern: '/api/*', expression: '^\\/api(?:\\/(.*))\\/?$' },
  ];
  const zisi = functionConfigFromBuild({ name: 'api', routes: zisiRoutes });
  assert.deepEqual(zisi.routes, zisiRoutes);
  assert.equal(apiRoutesOk({ functionsConfig: { api: zisi } }), true);
  assert.equal(fileMap.byHash['index.html'], undefined);
  assert.equal(functionMap.byHash.api, undefined);
  const missing = checkLocalLookups(
    { files: { 'index.html': fileSha }, byHash: {} },
    { functions: { api: functionSha }, byHash: {} },
  );
  assert.deepEqual(missing, [
    { branch: 'files', missingHash: fileSha },
    { branch: 'functions', missingHash: functionSha },
  ]);
});

test('a ready deploy is restored once and confirmed as the published deploy', async () => {
  const deployId = '6aefa304e95393802c4d7b16';
  const calls = [];
  const site = {
    id: STAGING_SITE_ID,
    name: STAGING_SITE_NAME,
    ssl_url: STAGING_URL,
    published_deploy: { id: deployId, context: 'production' },
  };
  const result = await publishReadyDeploy(async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify(site)) };
  }, deployId);
  assert.deepEqual(calls, [
    `POST /api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}/restore`,
    `GET /api/v1/sites/${STAGING_SITE_ID}`,
  ]);
  assert.deepEqual(result, { published: true, publishedDeployId: deployId, context: 'production' });
  await assert.rejects(() => publishReadyDeploy(async (method) => {
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify({ ...site, published_deploy: { id: '6aef9b65877e6e067c751d5b' } })) };
  }, deployId), /deploy_publish_unconfirmed/);
  await assert.rejects(() => publishReadyDeploy(async (method) => {
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify({ ...site, published_deploy: { id: deployId, context: 'deploy-preview' } })) };
  }, deployId), /refusing_deploy_context/);
});

test('a preparing deploy is not uploaded, and a function retry keeps the same token', () => {
  const body = "Access Denied: deploy must be in , not preparing / Access Denied: User does not have access / could not authenticate request";
  assert.equal(classifyUploadResponse(401, body), 'wait-prepared');
  assert.equal(classifyUploadResponse(401, 'Access Denied: User does not have access'), 'auth_required');
  assert.equal(classifyUploadResponse(500, 'could not authenticate request'), 'retry-same-token');
  const token = 'memory-token';
  assert.equal(functionUploadHeaders(token, 0).authorization, `Bearer ${token}`);
  assert.equal(functionUploadHeaders(token, 0)['x-nf-retry-count'], undefined);
  assert.equal(functionUploadHeaders(token, 1).authorization, `Bearer ${token}`);
  assert.equal(functionUploadHeaders(token, 1)['x-nf-retry-count'], '1');
  const routes = [{ pattern: '/health', literal: '/health' }, { pattern: '/api/*', expression: '^\\/api' }];
  const uploading = { state: 'uploading', context: 'production', required_functions: ['f1d3799c'] };
  const processing = { state: 'processing', context: 'production', required: [], required_functions: [] };
  const readyBare = { state: 'ready', context: 'production', required: [], required_functions: [], available_functions: [{ n: 'api', d: 'f1d3799c' }] };
  const readyRouted = { state: 'ready', context: 'production', available_functions: [{ n: 'api', d: 'f1d3799c', ro: routes }] };
  assert.equal(publishBlocker(uploading), 'wait');
  assert.equal(publishBlocker(processing), 'wait');
  assert.equal(publishBlocker(readyBare), 'invocation');
  assert.equal(publishBlocker({ ...readyRouted, available_functions: [{ n: 'api', im: 'stream', ro: routes }] }), 'ok');
  assert.equal(selectPublishSnapshot([uploading, processing, readyBare]), null);
  assert.equal(loginProbeReached(404), false);
  assert.equal(loginProbeReached(400), true);
  assert.equal(loginProbeReached({ status: 401, contentType: 'text/html', body: '<!doctype html><html>Login</html>' }), false);
  assert.equal(rollbackTarget().rollbackDeployId, '6af230ff9978904131f1329d');
  assert.equal(rollbackTarget().rollbackPermalink, 'https://6af230ff9978904131f1329d--oi-video-workflows-staging.netlify.app');
  assert.equal(needsPublishingLock({ id: '6aef3f786cc2af03c2ef1cd0', locked: false }), true);
  assert.equal(needsPublishingLock({ id: '6aef3f786cc2af03c2ef1cd0', locked: true }), false);
  assert.deepEqual(functionShasToUpload([], { abc: [{ routes: [{ pattern: '/api/*' }] }] }), ['abc']);
  const knownGood = { state: 'ready', context: 'production', available_functions: [{ n: 'api', im: 'stream', ro: [] }] };
  assert.equal(publishBlocker(knownGood), 'ok');
  assert.equal(assertPublishableDeploy(knownGood).invocationMode, 'stream');
  assert.throws(() => assertPublishableDeploy(readyBare), /refusing_invocation_mode/);
  assert.deepEqual(apiFunctionView(readyRouted)[0].routes, ['/health', '/api/*']);
  const registered = { state: 'ready', context: 'production', available_functions: [{ n: 'api', d: 'sha', im: 'stream', ro: routes }] };
  assert.equal(apiFunctionView(registered)[0].invocationMode, 'stream');
  assert.equal(functionInvocationMode({ runtimeAPIVersion: 2 }), 'stream');
  assert.equal(functionInvocationMode({ runtimeAPIVersion: 2, invocationMode: 'background' }), 'background');
  assert.equal(
    functionUploadQuery('6aef3f786cc2af03c2ef1cd0', { name: 'api', runtime: 'nodejs22.x', routes: [{ pattern: '/api/*' }], timeout: 10 }, 528289),
    '/api/v1/deploys/6aef3f786cc2af03c2ef1cd0/functions/api?runtime=nodejs22.x&invocation_mode=stream&timeout=10&size=528289',
  );
  assert.equal(functionConfigFromBuild({ name: 'api', routes: [{ pattern: '/health' }, { pattern: '/api/*' }] }).invocation_mode, 'stream');
  const zipConfig = functionsZipConfig('[functions]\n  directory = "netlify/functions"\n  node_bundler = "esbuild"\n  external_node_modules = ["express"]\n');
  assert.equal(functionsZipConfig('[functions]\n  timeout = 26\n  node_bundler = "esbuild"\n  external_node_modules = ["express"]\n')['*'].timeout, 26);
  assert.equal(zipConfig['*'].nodeBundler, 'esbuild_zisi');
  assert.deepEqual(zipConfig['*'].externalNodeModules, ['express']);
  const repoToml = functionsZipConfig(readFileSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'netlify.toml'), 'utf8'));
  assert.ok(repoToml['*'].externalNodeModules.includes('express'));
  assert.ok(repoToml['*'].externalNodeModules.includes('sharp'));
  assert.ok(repoToml['*'].includedFiles.some((item) => item.includes('@img/sharp-linux-x64')));
  assert.ok(repoToml['*'].includedFiles.some((item) => item.includes('@img/sharp-libvips-linux-x64')));
  assert.equal(repoToml['*'].timeout, 26);
});

function zipEntries(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const method = file.method || 0;
    const payload = method === 8 ? deflateRawSync(file.data) : file.data;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(Buffer.concat([local, payload]));
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

test('upload-check refuses an api bundle that eagerly requires a native the zip did not build for linux', () => {
  const win32 = ['api.cjs', 'node_modules/@img/sharp-win32-x64/sharp-win32-x64.node'];
  const eager = 'var import_sharp = __toESM(require("sharp"));';
  assert.ok(eagerNativePackagingProblems(eager, win32).some((problem) => problem.includes('eagerly requires sharp')));
  assert.deepEqual(eagerNativePackagingProblems(eager, [...win32, 'node_modules/@img/sharp-linux-x64/sharp-linux-x64.node']), []);
  assert.deepEqual(eagerNativePackagingProblems('const name = "sharp"; await import(name);', win32), []);
  const zip = zipEntries([
    { name: 'api.cjs', data: Buffer.from(eager), method: 8 },
    { name: 'node_modules/@img/sharp-win32-x64/sharp-win32-x64.node', data: Buffer.from('win32') },
  ]);
  assert.equal(readZipEntry(zip, 'api.cjs').toString('utf8'), eager);
  assert.ok(eagerNativeProblemsForZip(zip, win32).some((problem) => problem.includes('no linux sharp native')));
  assert.ok(linuxSharpPackagingProblems(win32).some((problem) => problem.includes('sharp-linux-x64')));
  assert.ok(linuxSharpPackagingProblems(['api.cjs', 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node']).some((problem) => problem.includes('libvips')));
  const packaged = ['api.cjs', 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node', 'node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7'];
  assert.deepEqual(linuxSharpPackagingProblems(packaged), []);
  assert.deepEqual(eagerNativePackagingProblems('const name = "sharp"; await import(name);', packaged), []);
  const safe = zipEntries([{ name: 'api.cjs', data: Buffer.from('const name = "sharp"; await import(name);') }]);
  assert.ok(eagerNativeProblemsForZip(safe, ['api.cjs']).some((problem) => problem.includes('sharp-linux-x64')));
  assert.deepEqual(linuxSharpVersions({ version: '0.35.5', optionalDependencies: { '@img/sharp-libvips-linux-x64': '1.3.4' } }), { sharp: '0.35.5', libvips: '1.3.4' });
});

test('packaged linux sharp loads from the api zip and shrinks a large photo', { timeout: 120000 }, async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const stage = mkdtempSync(resolve(tmpdir(), 'oi-sharp-stage-'));
  const extract = mkdtempSync(resolve(tmpdir(), 'oi-sharp-zip-'));
  try {
    const modules = stageLinuxSharp(repo, stage);
    const esbuild = await import('esbuild');
    const bundled = await esbuild.build({
      entryPoints: [resolve(repo, 'netlify/functions/api.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false,
      logLevel: 'silent',
      absWorkingDir: repo,
    });
    const api = Buffer.from(bundled.outputFiles[0].text);
    assert.equal(/require\(\s*["']sharp["']\s*\)/.test(api.toString('utf8')), false);
    let zip = zipEntries([{ name: 'api.cjs', data: api }]);
    zip = appendZipEntries(zip, linuxSharpZipEntries(modules));
    const names = listZipEntryNames(zip);
    assert.deepEqual(linuxSharpPackagingProblems(names), []);
    assert.deepEqual(eagerNativeProblemsForZip(zip, names), []);
    const unzipped = zipUnzippedBytes(zip);
    assert.ok(unzipped < API_ZIP_MAX_UNZIPPED_BYTES);
    const natives = names.filter((name) => name.endsWith('.node') || name.includes('libvips-cpp.so'));
    console.log(JSON.stringify({ event: 'linux_sharp_zip', zipBytes: zip.length, unzippedBytes: unzipped, natives }));
    extractZip(zip, extract);
    const nativeOnDisk = readFileSync(resolve(extract, 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node'));
    const packagedNative = readZipEntry(zip, 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node');
    assert.equal(nativeOnDisk.equals(packagedNative), true);
    writeFileSync(resolve(extract, 'resize.mjs'), `
      import { createRequire } from 'node:module';
      import { writeFileSync } from 'node:fs';
      const require = createRequire(new URL('./api.cjs', import.meta.url));
      const sharp = require('sharp');
      const native = require.resolve('@img/sharp-linux-x64/sharp.node');
      const libvips = require.resolve('@img/sharp-libvips-linux-x64/binary');
      const root = ${JSON.stringify(extract)};
      if (!native.startsWith(root) || !libvips.startsWith(root)) {
        console.error(JSON.stringify({ native, libvips, root }));
        process.exit(1);
      }
      const pixels = Buffer.alloc(1800 * 1400 * 3);
      for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 17) % 251;
      const raw = await sharp(pixels, { raw: { width: 1800, height: 1400, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
      const prepared = await sharp(raw, { failOn: 'none' }).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
      const meta = await sharp(prepared).metadata();
      const measure = { raw: raw.length, prepared: prepared.length, width: meta.width, height: meta.height, native, libvips };
      writeFileSync(new URL('./measure.json', import.meta.url), JSON.stringify(measure));
      console.log(JSON.stringify(measure));
    `);
    const env = { ...process.env, NODE_PATH: '' };
    delete env.NODE_OPTIONS;
    execFileSync(process.execPath, ['resize.mjs'], { cwd: extract, env, stdio: 'inherit' });
    const measure = JSON.parse(readFileSync(resolve(extract, 'measure.json'), 'utf8'));
    assert.ok(measure.raw > 600 * 1024);
    assert.ok(measure.prepared < measure.raw / 2);
    assert.ok(Math.max(measure.width, measure.height) <= 1200);
    assert.ok(measure.native.startsWith(extract));
    assert.ok(measure.libvips.startsWith(extract));
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(extract, { recursive: true, force: true });
  }
});

test('the api bundle does not eagerly require sharp', async () => {
  const esbuild = await import('esbuild');
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const source = readFileSync(resolve(repo, 'src/services/nfpa80Report.ts'), 'utf8');
  assert.equal(/from\s+["']sharp["']/.test(source), false);
  const result = await esbuild.build({
    entryPoints: [resolve(repo, 'netlify/functions/api.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    logLevel: 'silent',
    absWorkingDir: repo,
  });
  const text = result.outputFiles[0].text;
  assert.equal(/require\(\s*["']sharp["']\s*\)/.test(text), false);
  assert.equal(/require\(\s*["']@img\/sharp-/.test(text), false);
  assert.equal(/from\s+["']sharp["']/.test(text), false);
  assert.match(text, /import\s*\(\s*name\s*\)/);
});

test('upload-check refuses a small api zip that is missing dependencies', () => {
  assert.deepEqual(missingBundledModules(['node_modules/express/index.js', 'node_modules/pg/lib/index.js'], ['express', 'pg', 'jsonwebtoken']), ['jsonwebtoken']);
  const problems = functionZipProblems('api', 528437, ['dist/function-src/netlify/functions/api.cjs']);
  assert.ok(problems.some((problem) => problem.includes('under')));
  assert.ok(problems.some((problem) => problem.includes('node_modules/express/')));
  assert.deepEqual(functionZipProblems('api', 11_540_456, ['node_modules/express/index.js', 'node_modules/pg/lib/index.js', 'node_modules/jsonwebtoken/index.js']), []);
});

test('the invocation stamp is appended only to a temp copy of the api function', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const original = readFileSync(resolve(repo, 'netlify/functions/api.ts'), 'utf8');
  const destination = resolve(repo, 'dist/function-src-test-stamp');
  rmSync(destination, { recursive: true, force: true });
  const functionsDir = stageFunctionSources(repo, 'stamp-a', destination);
  const staged = readFileSync(resolve(functionsDir, 'api.ts'), 'utf8');
  assert.equal(readFileSync(resolve(repo, 'netlify/functions/api.ts'), 'utf8'), original);
  assert.equal(staged, original + invocationStampComment('stamp-a'));
  assert.notEqual(staged, readFileSync(resolve(functionsDir, 'photo-deletion-retry.ts'), 'utf8'));
  rmSync(destination, { recursive: true, force: true });
  assert.equal(dirname(functionsDir).endsWith('netlify'), true);
});

test('compare deploys reports function routes, redirects, and env names without secrets', () => {
  const goodId = '6aef3f786cc2af03c2ef1cd0';
  const badId = '6aefa304e95393802c4d7b16';
  const base = { site_id: STAGING_SITE_ID, state: 'ready', context: 'production', framework: null };
  const good = snapshotFromResponses({
    id: goodId,
    deploy: {
      ...base,
      commit_ref: 'cli',
      available_functions: [{
        n: 'api', d: 'sha-good', runtime: 'js',
        ro: [{ pattern: '/health', literal: '/health' }, { pattern: '/api/*', expression: '^\\/api' }],
        bd: { runtimeAPIVersion: 2, env: { DATABASE_URL: 'postgres://secret', JWT_SECRET: 'nf_should_not_print' } },
      }],
      edge_functions: { deno: 'edge-good' },
      redirects: [{ from: '/api/*', to: '/.netlify/functions/api', status: 200 }],
    },
    fileList: [{ path: '/_redirects', sha: 'redirects-good', size: 80 }],
    listStatus: { files: 200 },
  });
  const bad = snapshotFromResponses({
    id: badId,
    deploy: {
      ...base,
      commit_ref: 'digest',
      functions_config: { api: { routes: [], build_data: { runtimeAPIVersion: 2, env: ['JWT_SECRET'] } } },
      available_functions: [{ n: 'api', d: 'sha-good', runtime: 'js', ro: [] }],
      edge_functions: null,
    },
    fileList: [{ path: '_redirects', sha: 'redirects-bad', size: 90 }],
    listStatus: { files: 200 },
  });
  const report = compareDeploySnapshots(good, bad);
  const api = report.differences.find((item) => item.kind === 'function' && item.name === 'api');
  assert.equal(api.change, 'different');
  assert.deepEqual(api.fields.routes.good.map((route) => route.pattern), ['/health', '/api/*']);
  assert.deepEqual(api.fields.routes.bad, []);
  assert.deepEqual(api.fields.build_data.good.envVarNames, ['DATABASE_URL', 'JWT_SECRET']);
  assert.ok(report.differences.some((item) => item.kind === 'redirects'));
  assert.ok(report.differences.some((item) => item.kind === 'files' && item.good._redirects.sha === 'redirects-good'));
  const text = JSON.stringify(report);
  assert.equal(text.includes('postgres://secret'), false);
  assert.equal(text.includes('nf_should_not_print'), false);
  assert.equal(scrubDeployValue({ authorization: 'Bearer abc', note: 'Bearer abc' }).note, '[redacted]');
});

test('a production deploy includes netlify.toml and refuses any other context', () => {
  const routes = [
    { pattern: '/health', literal: '/health' },
    { pattern: '/api/*', expression: '^\\/api(?:\\/(.*))\\/?$' },
  ];
  const files = includeNetlifyToml({ files: { '/index.html': 'abc' }, byHash: {} }, fileURLToPath(new URL('../netlify.toml', import.meta.url)));
  assert.equal(typeof files.files['/netlify.toml'], 'string');
  assert.equal(files.files['/netlify.toml'].length, 40);
  const body = productionDeployBody({
    files: files.files,
    functions: { api: 'f'.repeat(64) },
    functionsConfig: { api: { routes } },
  });
  assert.equal(body.draft, false);
  assert.equal(body.files['/netlify.toml'], files.files['/netlify.toml']);
  const ready = { context: 'production', available_functions: [{ n: 'api', im: 'stream', ro: [] }] };
  assert.equal(assertPublishableDeploy(ready).context, 'production');
  assert.throws(() => assertPublishableDeploy({ ...ready, context: 'deploy-preview' }), /refusing_deploy_context/);
  assert.throws(() => assertPublishableDeploy({ context: 'production', available_functions: [{ n: 'api', im: null, ro: [] }] }), /refusing_invocation_mode/);
});

test('facility dashboard packaging accepts CRLF checkout and still refuses a changed marker', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const source = resolve(repo, 'facility-dashboard');
  const stage = (transform) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'oi-dash-src-'));
    cpSync(source, dir, { recursive: true });
    const htmlPath = resolve(dir, 'portal-source.html');
    writeFileSync(htmlPath, transform(readFileSync(htmlPath, 'utf8')));
    return dir;
  };
  const expectGuarded = (sourceRoot) => {
    const dest = mkdtempSync(resolve(tmpdir(), 'oi-dash-out-'));
    buildFacilityDashboard(dest, { sourceRoot });
    const html = readFileSync(resolve(dest, 'index.html'), 'utf8');
    assert.equal(html.includes('\r'), false);
    assert.match(html, /Checking access for this account/);
    assert.match(html, /api\('\/portfolio\/facility-dashboard-access'\)/);
    assert.match(html, /This account cannot open the facility dashboard/);
    assert.equal(html.includes('missing profile -> stay'), false);
    rmSync(dest, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  };
  const lf = readFileSync(resolve(source, 'portal-source.html'), 'utf8').replace(/\r\n/g, '\n');
  expectGuarded(stage(() => lf));
  expectGuarded(stage(() => lf.replace(/\n/g, '\r\n')));
  const brokenRoot = stage((html) => html.replace('missing profile -> stay (no lockout).', 'marker removed'));
  const brokenDest = mkdtempSync(resolve(tmpdir(), 'oi-dash-broken-'));
  assert.throws(() => buildFacilityDashboard(brokenDest, { sourceRoot: brokenRoot }), /Dashboard source changed: async function routeByType/);
  assert.equal(existsSync(resolve(brokenDest, 'index.html')), false);
  rmSync(brokenRoot, { recursive: true, force: true });
  rmSync(brokenDest, { recursive: true, force: true });
});

test('staging env report names the measurement setting and keeps secret values out', () => {
  const secret = 'sk-ant-this-value-must-not-appear';
  const names = envNamesFromPayload([
    { key: 'ANTHROPIC_API_KEY', values: [{ value: secret, context: 'all' }] },
    { key: 'OI_RECOGNITION_ENABLED', values: [{ value: 'true', context: 'all' }] },
    { name: 'OTHER', value: secret },
  ]);
  const report = siteEnvReport(names, false);
  const text = JSON.stringify(report);
  assert.equal(text.includes(secret), false);
  assert.deepEqual(report.recognitionEnvPresent, [
    { name: 'OI_RECOGNITION_ENABLED', present: true },
    { name: 'ANTHROPIC_API_KEY', present: true },
  ]);
  assert.equal(report.measurementReader.write, false);
  assert.equal(report.measurementReader.present, false);
  assert.equal(report.measurementReader.intendedValue, 'anthropic');
  assert.equal(report.measurementReader.siteId, STAGING_SITE_ID);
  const body = measurementReaderEnvBody();
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0].key, MEASUREMENT_READER_KEY);
  assert.deepEqual(body[0].scopes, ['functions']);
  assert.deepEqual(body[0].values, [{ context: 'production', value: 'anthropic' }]);
  const createPath = accountEnvPath('account-1');
  const patchPath = accountEnvPath('account-1', { key: MEASUREMENT_READER_KEY });
  assert.equal(createPath, `/api/v1/accounts/account-1/env?site_id=${STAGING_SITE_ID}`);
  assert.equal(patchPath, `/api/v1/accounts/account-1/env/${MEASUREMENT_READER_KEY}?site_id=${STAGING_SITE_ID}`);
  assert.equal(assertStagingApiPath(createPath), createPath);
  assert.equal(assertStagingApiPath(patchPath), patchPath);
  assert.throws(() => assertStagingApiPath(`/api/v1/accounts/account-1/env?site_id=${PRODUCTION_SITE_ID}`), /refusing_production/);
  assert.throws(() => accountIdFromSite({ id: PRODUCTION_SITE_ID, account_id: 'account-1' }), /refusing_production/);
  assert.equal(accountIdFromSite({ id: STAGING_SITE_ID, account_id: 'account-uuid', account_slug: 'slug' }), 'account-uuid');
  assert.equal(accountIdFromSite({ id: STAGING_SITE_ID, account_slug: 'slug' }), 'slug');
  assert.equal(measurementReaderAlreadySet([{ key: MEASUREMENT_READER_KEY, values: [{ context: 'production', value: 'anthropic' }] }]), true);
  assert.equal(measurementReaderAlreadySet([{ key: MEASUREMENT_READER_KEY, values: [{ context: 'production', value: secret }] }]), false);
  assert.equal(String(measurementReaderAlreadySet([{ key: 'ANTHROPIC_API_KEY', values: [{ value: secret }] }])).includes(secret), false);
  assert.equal(JSON.stringify(scrubDeployValue(report)).includes(secret), false);
  assert.equal(recognitionEnvReport([])[1].present, false);
  assert.equal(measurementReaderReport(names, true).write, true);
});
