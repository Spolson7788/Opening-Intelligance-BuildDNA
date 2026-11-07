// One staging publish of commit 16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5.
// Hard-locked to oi-video-workflows-staging. Refuses production. One attempt.
// Does not print secrets. Default is a dry run; publish requires --publish-approved.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_COMMIT = '16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5';
export const STAGING_SITE_ID = 'b64bf33c-a131-4ae2-b2b0-9aec16e9f77b';
export const STAGING_SITE_NAME = 'oi-video-workflows-staging';
export const STAGING_URL = 'https://oi-video-workflows-staging.netlify.app';
export const PRODUCTION_SITE_ID = 'b4e0fc62-86ce-4a26-9ebf-26d7386f4b01';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageDir = resolve(root, 'dist/staging-package-16abbf4');
const journalDir = resolve(root, 'dist/staging-publish-journal-16abbf4');
const attemptPath = resolve(journalDir, 'publication-attempt.json');
const dryRunPath = resolve(journalDir, 'publication-dry-run.json');

export function hashTree(directory, prefix = '') {
  if (!existsSync(directory)) return {};
  const name = prefix.replace(/\\/g, '/');
  if (statSync(directory).isFile()) {
    const bytes = readFileSync(directory);
    return { [name]: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } };
  }
  const out = {};
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const child = `${name}/${entry.name}`.replace(/\\/g, '/');
    if (entry.isDirectory()) Object.assign(out, hashTree(path, child));
    else {
      const bytes = readFileSync(path);
      out[child] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    }
  }
  return out;
}

export function assertHeadCommit(repo = root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  if (head !== PINNED_COMMIT) {
    const error = new Error('refusing_commit_mismatch');
    error.code = 'refusing_commit_mismatch';
    throw error;
  }
  return head;
}

export function assertSite(site) {
  const id = site?.id || '';
  const name = site?.name || '';
  const url = site?.url || site?.ssl_url || '';
  if (id === PRODUCTION_SITE_ID || /production/i.test(name) || /oi-production/i.test(url)) {
    const error = new Error('refusing_production');
    error.code = 'refusing_production';
    throw error;
  }
  let host = '';
  try { host = url ? new URL(url).hostname : ''; } catch { host = ''; }
  if (id !== STAGING_SITE_ID || name !== STAGING_SITE_NAME || (host && host !== 'oi-video-workflows-staging.netlify.app')) {
    const error = new Error('refusing_site_mismatch');
    error.code = 'refusing_site_mismatch';
    throw error;
  }
  return { id, name, url: STAGING_URL };
}

function trackedDirty(repo = root) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trimEnd()).filter(Boolean).filter((line) => !line.slice(3).trim().startsWith('dist/'));
}

function readPin() {
  const pinPath = resolve(packageDir, 'package-pin.json');
  if (!existsSync(pinPath)) {
    const error = new Error('package_not_built');
    error.code = 'package_not_built';
    throw error;
  }
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.commit !== PINNED_COMMIT) {
    const error = new Error('refusing_package_commit');
    error.code = 'refusing_package_commit';
    throw error;
  }
  const files = {
    ...hashTree(resolve(packageDir, 'publish'), 'publish'),
  };
  for (const source of ['netlify.toml', 'netlify/functions', 'plugins/function-evidence']) {
    files[`source:${source}`] = { tree: hashTree(resolve(root, source), source) };
  }
  const packageSha256 = createHash('sha256').update(JSON.stringify({ commit: PINNED_COMMIT, files })).digest('hex');
  if (packageSha256 !== pin.packageSha256) {
    const error = new Error('refusing_package_checksum');
    error.code = 'refusing_package_checksum';
    throw error;
  }
  return { packageSha256, fileCount: Object.keys(files).length };
}

function tokenPresent() {
  const value = process.env.NETLIFY_AUTH_TOKEN;
  return typeof value === 'string' && value.length > 0;
}

async function readLiveDeploy() {
  const response = await fetch(`https://api.netlify.com/api/v1/sites/${STAGING_SITE_ID}`, {
    headers: { authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}` },
  });
  if (!response.ok) {
    const error = new Error('site_lookup_failed');
    error.code = 'site_lookup_failed';
    throw error;
  }
  const site = await response.json();
  assertSite({ id: site.id, name: site.name, url: site.ssl_url || site.url });
  const deploy = site.published_deploy || {};
  return {
    rollbackDeployId: deploy.id || null,
    rollbackCommit: deploy.commit_ref || null,
    rollbackPermalink: deploy.id ? `https://${deploy.id}--oi-video-workflows-staging.netlify.app` : null,
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function runPublish(pin) {
  mkdirSync(journalDir, { recursive: true });
  if (existsSync(attemptPath)) {
    const error = new Error('attempt_already_recorded');
    error.code = 'attempt_already_recorded';
    throw error;
  }
  if (!tokenPresent()) {
    const error = new Error('credentials_required');
    error.code = 'credentials_required';
    throw error;
  }
  const dirty = trackedDirty();
  if (dirty.length) {
    const error = new Error('working_tree_dirty');
    error.code = 'working_tree_dirty';
    throw error;
  }
  const created = openSync(attemptPath, 'wx');
  closeSync(created);
  const journal = {
    state: 'attempt-prepared',
    commit: PINNED_COMMIT,
    siteId: STAGING_SITE_ID,
    siteName: STAGING_SITE_NAME,
    packageSha256: pin.packageSha256,
    rollbackDeployId: null,
    rollbackPermalink: null,
    createdAt: new Date().toISOString(),
  };
  writeJson(attemptPath, journal);
  return (async () => {
    try {
      const live = await readLiveDeploy();
      Object.assign(journal, live, { state: 'attempt-prepared' });
      writeJson(attemptPath, journal);
      const cli = spawnSync('npx', ['--yes', 'netlify', 'deploy', '--prod', '--site', STAGING_SITE_ID,
        '--dir', resolve(packageDir, 'publish'), '--functions', resolve(root, 'netlify/functions'),
        '--message', `staging ${PINNED_COMMIT}`], { cwd: root, encoding: 'utf8' });
      journal.state = 'response-received';
      journal.cliStatus = cli.status;
      writeJson(attemptPath, journal);
      if (cli.status !== 0) {
        journal.state = 'failed';
        journal.failure = 'deploy_command_failed';
        writeJson(attemptPath, journal);
        const error = new Error('deploy_command_failed');
        error.code = 'deploy_command_failed';
        throw error;
      }
      const id = (cli.stdout || '').match(/([0-9a-f]{24})--oi-video-workflows-staging\.netlify\.app/i);
      journal.deployId = id ? id[1] : null;
      journal.deployUrl = STAGING_URL;
      journal.state = journal.deployId ? 'ready' : 'response-received';
      journal.finishedAt = new Date().toISOString();
      writeJson(attemptPath, journal);
      return journal;
    } catch (error) {
      if (journal.state !== 'failed') {
        journal.state = 'failed';
        journal.failure = error.code || 'publish_failed';
        writeJson(attemptPath, journal);
      }
      throw error;
    }
  })();
}

async function main() {
  const publish = process.argv.includes('--publish-approved');
  const dryRun = process.argv.includes('--dry-run') || !publish;
  if (publish && dryRun && process.argv.includes('--dry-run')) {
    const error = new Error('choose_one_mode');
    error.code = 'choose_one_mode';
    throw error;
  }
  assertHeadCommit(root);
  assertSite({ id: STAGING_SITE_ID, name: STAGING_SITE_NAME, url: STAGING_URL });
  let productionRefused = false;
  try { assertSite({ id: PRODUCTION_SITE_ID, name: 'oi-production', url: 'https://oi-production.netlify.app' }); }
  catch (error) { productionRefused = error.code === 'refusing_production'; }
  if (!productionRefused) throw new Error('production_guard_failed');

  if (!publish) {
    let packageSha256 = null;
    let packageState = 'package_not_built';
    try {
      packageSha256 = readPin().packageSha256;
      packageState = 'package_checksum_matched';
    } catch (error) {
      if (error.code !== 'package_not_built' && error.code !== 'refusing_package_checksum' && error.code !== 'refusing_package_commit') throw error;
      packageState = error.code;
    }
    mkdirSync(journalDir, { recursive: true });
    const record = {
      state: 'dry-run',
      commit: PINNED_COMMIT,
      siteId: STAGING_SITE_ID,
      siteName: STAGING_SITE_NAME,
      packageState,
      packageSha256,
      rollback: tokenPresent() ? 'not-fetched-on-dry-run' : 'credentials-not-present',
      productionRefused: true,
      createdAt: new Date().toISOString(),
    };
    writeJson(dryRunPath, record);
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const pin = readPin();
  const journal = await runPublish(pin);
  console.log(JSON.stringify({ state: journal.state, commit: PINNED_COMMIT, siteId: STAGING_SITE_ID, deployId: journal.deployId || null, rollbackDeployId: journal.rollbackDeployId }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.code || 'publisher_failed');
    process.exit(1);
  });
}
