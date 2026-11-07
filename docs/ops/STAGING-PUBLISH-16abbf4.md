# Staging publish for 16abbf4

One publish of pull request 18 to **oi-video-workflows-staging** only. The staging migration is already applied. Do not apply it again. Do not publish to production. Do not run `npm run migrate`.

Pinned commit: `16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5`

Site: `oi-video-workflows-staging` (`b64bf33c-a131-4ae2-b2b0-9aec16e9f77b`), https://oi-video-workflows-staging.netlify.app

The publisher refuses `oi-production` (`b4e0fc62-86ce-4a26-9ebf-26d7386f4b01`) and every other site. It checks the git commit and the package checksums, writes one attempt journal, and records the current live deploy as the rollback before uploading. A second attempt is refused while that journal exists. On a failure, do not run it again; rename the journal only with a separate decision.

Build this on the PC that will publish. This environment does not build or upload the package.

```
git fetch origin cursor/roboflow-door-hardware-9550
git checkout cursor/roboflow-door-hardware-9550
node scripts/build-staging-package-16abbf4.mjs
node scripts/artifact-publisher-staging-16abbf4.mjs --dry-run
```

The application tree must be `16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5`. The branch tip may also contain only these publisher files. Any other change is refused.

The build prints `packageSha256`. Do not rebuild if that value is still `ab779e93cffb8f8958dbf95409dcad60891ae3e96281a2ad3809494b40bb3c2d`. This attempt uses `dist/staging-publish-journal-16abbf4-r7/`. Leave the earlier journal directories untouched. The deploy is created with `draft: false`, the same switch `netlify deploy --prod` uses, so its context is `production`. The file manifest includes `/netlify.toml`. Publish is refused unless the created deploy reports context `production` and the `api` function has routes `/health` and `/api/*`. The deploy body includes `functions_config` so the `api` function keeps routes `/health` and `/api/*`. `--upload-check` fails unless those routes are present, whether each route is a string or an object with `pattern`. The objects are sent unchanged. To put the previous live deploy back, once:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --rollback-approved
```

That restores only `6aef3f786cc2af03c2ef1cd0` on this staging site and writes `dist/staging-publish-journal-16abbf4-rollback/rollback-attempt.json`. It does not create a new deploy. The dry run should say `package_checksum_matched`, `productionRefused: true`, and a `rollbackDeployId`. It does not upload.

```
node scripts/artifact-publisher-staging-16abbf4.mjs --dry-run
```

The Netlify CLI install is loaded from `C:\Users\spols\Documents\Codex\2026-10-23\task\.local-netlify-cli\node_modules\netlify-cli` (v27.14.2). Pass `--netlify-cli-dir` only if that folder moved. The publisher uses that install's dev-utils to confirm the logged-in account and to take an in-memory token. The token is not printed or written. Requests go only to `api.netlify.com` for site `b64bf33c-a131-4ae2-b2b0-9aec16e9f77b` and for the deploy id this run creates. `auth_required` and `auth_account_mismatch` are login problems. `deploy_create_failed`, `deploy_upload_failed`, `deploy_poll_failed`, `deploy_not_ready`, and `deploy_publish_failed` are upload problems. `failure.json` records `branch` (`files` or `functions`) and `missingHash` when a required digest does not resolve. File digests are SHA-1 and `required` returns those SHA-1 values. Function digests are SHA-256 and `required_functions` returns those SHA-256 values. The attempt file is `dist/staging-publish-journal-16abbf4-r7/publication-attempt.json`. An empty `required` list is not uploaded. The script waits until the deploy state is `prepared` before any PUT, including when `required_functions` is already populated during `preparing`. To finish deploy `6aefac034fc7533e305439c9`:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --inspect-deploy 6aefac034fc7533e305439c9
node scripts/artifact-publisher-staging-16abbf4.mjs --resume-deploy 6aefac034fc7533e305439c9
```

`--inspect-deploy` only GETs the deploy. It prints `deployState`, `context`, and `apiRoutes`. Resume keeps polling after the state is `ready` until those routes are present, then calls restore.

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

When `routesOk` and `netlifyToml` are true and `context` is `production`:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --publish-approved
```

Rollback is redeploying that recorded deploy in the Netlify UI for this staging site only. Do not delete it.
