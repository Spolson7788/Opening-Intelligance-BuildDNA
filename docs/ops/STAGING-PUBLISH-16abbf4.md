# Staging publish for 16abbf4

One publish of pull request 18 to **oi-video-workflows-staging** only. The staging migration is already applied. Do not apply it again. Do not publish to production. Do not run `npm run migrate`.

Pinned app commit: `4322bb36de164037fd463639a2b0b2fc5a17a345`. A later commit is accepted only when its diff from that pin is publisher files.

Site: `oi-video-workflows-staging` (`b64bf33c-a131-4ae2-b2b0-9aec16e9f77b`), https://oi-video-workflows-staging.netlify.app

The publisher refuses `oi-production` (`b4e0fc62-86ce-4a26-9ebf-26d7386f4b01`) and every other site. It checks the git commit and the package checksums, writes one attempt journal, and records the current live deploy as the rollback before uploading. A second attempt is refused while that journal exists. On a failure, do not run it again; rename the journal only with a separate decision.

Build this on the PC that will publish. This environment does not build or upload the package.

```
git fetch origin cursor/purchasing-nfpa80-9550
git checkout cursor/purchasing-nfpa80-9550
git pull origin cursor/purchasing-nfpa80-9550
node scripts/build-staging-package-16abbf4.mjs
node scripts/artifact-publisher-staging-16abbf4.mjs --upload-check
```

Rebuild `dist/staging-package-16abbf4` with that command. The old package records commit `16abbf4` and is refused. The build writes a new `packageSha256` into `package-pin.json`. There is no checksum to paste back into git. The publisher recomputes it from the built files and the commit recorded in that pin. The recorded commit must be `4322bb36de164037fd463639a2b0b2fc5a17a345` or a publisher-only descendant. Any other change is refused.

Install the API dependencies before the upload check. From the repo root:

```
npm ci
```

The function zip is built from that `node_modules`. `@supabase/supabase-js` is not imported by the api function. The check requires `express`, `pg`, and `jsonwebtoken` inside the zip, and an api zip of at least 5 MB. The build prints a new `packageSha256`. Do not reuse `ab779e93cffb8f8958dbf95409dcad60891ae3e96281a2ad3809494b40bb3c2d`; that checksum belongs to the PR 18 package. This attempt uses `dist/staging-publish-journal-16abbf4-r21/`. Leave `dist/staging-publish-journal-16abbf4-r20/` and the earlier journal directories untouched. Do not publish `6aefb27ce9feb6a9e881d55d` or `6aefb45b48f193074a694e72`. Before creating a deploy, the publisher locks the deploy that is already published so a `draft: false` deploy cannot go live on its own. Restore runs only after `invocationMode` is `stream`. A function is publishable only when its `invocationMode` is `stream`, the same field the known-good deploy exposes. A Netlify privacy-gate `401` HTML page is not a pass. The deploy is created with `draft: false`, the same switch `netlify deploy --prod` uses, so its context is `production`. The file manifest includes `/netlify.toml`. Publish is refused unless the created deploy reports context `production` and the `api` function's `invocationMode` is `stream`. `functions_config` includes `invocation_mode: stream` and `build_data.runtimeAPIVersion: 2`, and the function PUT query includes `invocation_mode=stream`. `--upload-check` fails unless those routes are present, whether each route is a string or an object with `pattern`. The objects are sent unchanged. To put the previous live deploy back, once:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --rollback-approved
```

That restores only `6af0d6bf1dfb22798eb09b94` on this staging site and writes `dist/staging-publish-journal-16abbf4-rollback/rollback-attempt.json`. It does not create a new deploy. The dry run should say `package_checksum_matched`, `productionRefused: true`, and a `rollbackDeployId`. It does not upload.

```
node scripts/artifact-publisher-staging-16abbf4.mjs --dry-run
```

The Netlify CLI install is loaded from `C:\Users\spols\Documents\Codex\2026-10-23\task\.local-netlify-cli\node_modules\netlify-cli` (v27.14.2). Pass `--netlify-cli-dir` only if that folder moved. The publisher uses that install's dev-utils to confirm the logged-in account and to take an in-memory token. The token is not printed or written. Requests go only to `api.netlify.com` for site `b64bf33c-a131-4ae2-b2b0-9aec16e9f77b` and for the deploy id this run creates. `auth_required` and `auth_account_mismatch` are login problems. `deploy_create_failed`, `deploy_upload_failed`, `deploy_poll_failed`, `deploy_not_ready`, and `deploy_publish_failed` are upload problems. `failure.json` records `branch` (`files` or `functions`) and `missingHash` when a required digest does not resolve. File digests are SHA-1 and `required` returns those SHA-1 values. Function digests are SHA-256 and `required_functions` returns those SHA-256 values. The attempt file is `dist/staging-publish-journal-16abbf4-r21/publication-attempt.json`. The `api` function upload query and `functions_config.invocation_mode` are both `stream`. Function uploads send `runtime`, `invocation_mode` (`stream` for a v2 function), `timeout`, and `size`. An empty `required` list is not uploaded. The script waits until the deploy state is `prepared` before any PUT. Do not resume `6aefac034fc7533e305439c9`.

Read-only view of the routes on the working deploy. It GETs that deploy and prints `deployState`, `context`, `apiRoutes`, and `invocationMode` from `ro`/`routes` and `im`:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --diagnose 6aefbbdaf23ff8bc7521d5ba
node scripts/artifact-publisher-staging-16abbf4.mjs --inspect-deploy 6aef3f786cc2af03c2ef1cd0

`--diagnose` only sends GET requests. It compares function name, sha, runtime, invocationMode, routes, and size with `6aef3f786cc2af03c2ef1cd0`, tries the function log endpoints, and prints whether this deploy id is `published_deploy.id`. Tokens are redacted.
node scripts/artifact-publisher-staging-16abbf4.mjs --check-deploy 6aefb27ce9feb6a9e881d55d
```

`--check-deploy` only reads. It POSTs `{}` to that deploy's permalink `/api/auth/login` with no token. `publishable` is true when the deploy is `ready`, its context is `production`, and the probe status is not 404. An empty `routes` list matches the known-good deploy. `rollbackDeployId` is always `6af0d6bf1dfb22798eb09b94`. The journal `commit` is the publisher HEAD, and `packageCommit` stays `4322bb36de164037fd463639a2b0b2fc5a17a345`.

Resume waits until the deploy state is `prepared` before any file or function PUT. A 401 that says the deploy is still `preparing` is not an authentication failure. The same in-memory token is reused, and a function retry sends `X-Nf-Retry-Count`. After the deploy is ready, resume calls restore and records success only when `published_deploy.id` is that deploy and its context is `production`.

Resume is allowed only for a deploy id recorded by an earlier journal from this publisher. A `preparing` deploy is polled until `prepared`. A `ready` deploy skips uploads. Once the deploy is ready, resume calls restore once, then records `published: true` and `publishedDeployId` only when the site's `published_deploy.id` equals that deploy. A resume journal without `published: true` can be run again. The upload creates a production-context deploy, uploads only the required digests, waits until the deploy is ready, checks the context and routes, then publishes it. It does not run `netlify deploy`.

Read-only compare of the CLI deploy and the digest deploy. This only sends GET requests and prints route, checksum, runtime, redirect, edge-function, and env-variable-name differences:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --compare-deploys 6aef3f786cc2af03c2ef1cd0 6aefa304e95393802c4d7b16
```

Check the local manifest before publishing. This does not contact Netlify:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --upload-check
```

When `routesOk`, `invocationOk`, and `netlifyToml` are true and `context` is `production`:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --publish-approved
```

That writes `dist/staging-publish-journal-16abbf4-r21/`. It locks the current published deploy first, then creates a new deploy. It does not reuse `6aefb45b48f193074a694e72`.

Rollback is redeploying that recorded deploy in the Netlify UI for this staging site only. Do not delete it.
