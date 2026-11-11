# Staging publish for 16abbf4

One publish of pull request 18 to **oi-video-workflows-staging** only. The staging migration is already applied. Do not apply it again. Do not publish to production. Do not run `npm run migrate`.

Pinned app commit: `26dfb951b06e3591386e6ac1fb7c75043a651747`. This is release r52. A later commit is accepted only when its diff from that pin is publisher files. It includes the Facility Dashboard for customer office users: the visit list and stored visit PDF, advised and performed dates, the customer-office gate, and the catalog, planning, finance, and history pages. No new migration is required. A measurement photo is read only when `OI_MEASUREMENT_READER` is `anthropic` on this staging site and recognition is already enabled. That setting is already `anthropic`, so the approved publish skips the env write. This pin is based on publisher `6957785c7ff75be284d9ef4a734571b5c3a78d23`.

Site: `oi-video-workflows-staging` (`b64bf33c-a131-4ae2-b2b0-9aec16e9f77b`), https://oi-video-workflows-staging.netlify.app

The publisher refuses `oi-production` (`b4e0fc62-86ce-4a26-9ebf-26d7386f4b01`) and every other site. It checks the git commit and the package checksums, writes one attempt journal, and records the current live deploy as the rollback before uploading. A second attempt is refused while that journal exists. On a failure, do not run it again; rename the journal only with a separate decision.

Build this on the PC that will publish. This environment does not build or upload the package.

```
git fetch origin cursor/purchasing-nfpa80-9550
git checkout cursor/purchasing-nfpa80-9550
git pull origin cursor/purchasing-nfpa80-9550
node scripts/build-staging-package-16abbf4.mjs
node scripts/artifact-publisher-staging-16abbf4.mjs --upload-check
node scripts/artifact-publisher-staging-16abbf4.mjs --dry-run
```

`build-staging-package-16abbf4.mjs` only builds the local package. It ignores publish flags. The only publish command is `node scripts/artifact-publisher-staging-16abbf4.mjs --publish-approved`. Do not run a hosted migration for this release. `migrations/20261108181500_purchasing_api_insert_policies.sql` records INSERT policies already applied on staging. Routing uses `oi_private.area_row_covers`, created in `20261103180000` and covered by `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA oi_private` in `20261103223000` when `oi_pr2_api` already existed. That grant was not rechecked on the hosted database.

Rebuild `dist/staging-package-16abbf4` with that command. The old package records commit `16abbf4` and is refused. The build writes a new `packageSha256` into `package-pin.json`. There is no checksum to paste back into git. The publisher recomputes it from the built files and the commit recorded in that pin. The recorded commit must be `26dfb951b06e3591386e6ac1fb7c75043a651747` or a publisher-only descendant. Any other change is refused.

Install the API dependencies before the upload check. From the repo root:

```
npm ci
```

The function zip is built from that `node_modules`. `@supabase/supabase-js` is not imported by the api function. The check requires `express`, `pg`, and `jsonwebtoken` inside the zip, and an api zip of at least 5 MB. It also reads the api bundle from that zip and fails the release when the bundle eagerly requires `sharp` or `@img/sharp-*` without a linux native, or when the zip is missing `@img/sharp-linux-x64` `.node` or `@img/sharp-libvips-linux-x64`. Netlify's Node runtime is x64 glibc, so musl and arm64 builds are not packaged. The publisher copies those two linux packages into the zip when the Windows `node_modules` does not already contain them. An api zip that unpacks past 250 MB is refused. The build prints a new `packageSha256`. Do not reuse `ab779e93cffb8f8958dbf95409dcad60891ae3e96281a2ad3809494b40bb3c2d`; that checksum belongs to the PR 18 package. This attempt uses `dist/staging-publish-journal-16abbf4-r52/`. Leave `dist/staging-publish-journal-16abbf4-r51/` and the earlier journal directories untouched. The r51 journal belongs to the live release and must not be reused. Facility dashboard pages are static files under `/facility-dashboard/`: `index.html`, `commercial.html`, `planning.html`, `finance.html`, and `history.html`. They do not add a function route. `/health` and `/api/*` stay the api routes. Do not publish `6aefb27ce9feb6a9e881d55d` or `6aefb45b48f193074a694e72`. Before creating a deploy, the publisher locks the deploy that is already published so a `draft: false` deploy cannot go live on its own. Restore runs only after `invocationMode` is `stream`. A function is publishable only when its `invocationMode` is `stream`, the same field the known-good deploy exposes. A Netlify privacy-gate `401` HTML page is not a pass. The deploy is created with `draft: false`, the same switch `netlify deploy --prod` uses, so its context is `production`. The file manifest includes `/netlify.toml`. Publish is refused unless the created deploy reports context `production` and the `api` function's `invocationMode` is `stream`. `functions_config` includes `invocation_mode: stream` and `build_data.runtimeAPIVersion: 2`, and the function PUT query includes `invocation_mode=stream`. `--upload-check` fails unless those routes are present, whether each route is a string or an object with `pattern`. The objects are sent unchanged. To put the previous live deploy back, once:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --rollback-approved
```

That restores only `6af230ff9978904131f1329d` on this staging site and writes `dist/staging-publish-journal-16abbf4-rollback/rollback-attempt.json`. It does not create a new deploy. The dry run should say `package_checksum_matched`, `productionRefused: true`, and a `rollbackDeployId`. It does not upload.

```
node scripts/artifact-publisher-staging-16abbf4.mjs --dry-run
```

The Netlify CLI install is loaded from `C:\Users\spols\Documents\Codex\2026-10-23\task\.local-netlify-cli\node_modules\netlify-cli` (v27.14.2). Pass `--netlify-cli-dir` only if that folder moved. The publisher uses that install's dev-utils to confirm the logged-in account and to take an in-memory token. The token is not printed or written. Requests go only to `api.netlify.com` for site `b64bf33c-a131-4ae2-b2b0-9aec16e9f77b` and for the deploy id this run creates. `auth_required` and `auth_account_mismatch` are login problems. `deploy_create_failed`, `deploy_upload_failed`, `deploy_poll_failed`, `deploy_not_ready`, and `deploy_publish_failed` are upload problems. `failure.json` records `branch` (`files` or `functions`) and `missingHash` when a required digest does not resolve. File digests are SHA-1 and `required` returns those SHA-1 values. Function digests are SHA-256 and `required_functions` returns those SHA-256 values. The attempt file is `dist/staging-publish-journal-16abbf4-r52/publication-attempt.json`. The `api` function upload query and `functions_config.invocation_mode` are both `stream`. Function uploads send `runtime`, `invocation_mode` (`stream` for a v2 function), `timeout`, and `size`. An empty `required` list is not uploaded. The script waits until the deploy state is `prepared` before any PUT. Do not resume `6aefac034fc7533e305439c9`.

Read-only view of the routes on the working deploy. It GETs that deploy and prints `deployState`, `context`, `apiRoutes`, and `invocationMode` from `ro`/`routes` and `im`:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --diagnose 6aefbbdaf23ff8bc7521d5ba
node scripts/artifact-publisher-staging-16abbf4.mjs --inspect-deploy 6aef3f786cc2af03c2ef1cd0

`--diagnose` only sends GET requests. It compares function name, sha, runtime, invocationMode, routes, and size with `6aef3f786cc2af03c2ef1cd0`, tries the function log endpoints, and prints whether this deploy id is `published_deploy.id`. Tokens are redacted.
node scripts/artifact-publisher-staging-16abbf4.mjs --check-deploy 6aefb27ce9feb6a9e881d55d
```

`--check-deploy` only reads. It POSTs `{}` to that deploy's permalink `/api/auth/login` with no token. `publishable` is true when the deploy is `ready`, its context is `production`, and the probe status is not 404. An empty `routes` list matches the known-good deploy. `rollbackDeployId` is always `6af230ff9978904131f1329d`. The journal `commit` is the publisher HEAD, and `packageCommit` stays `26dfb951b06e3591386e6ac1fb7c75043a651747`. A privacy-gate `401` HTML page is not a pass. Do not turn the privacy gate off.

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

That writes `dist/staging-publish-journal-16abbf4-r52/`. It does not reuse `dist/staging-publish-journal-16abbf4-r51/`. Before creating a deploy, and only on `--publish-approved`, it checks `OI_MEASUREMENT_READER` through `GET /api/v1/accounts/{account_id}/env?site_id=b64bf33c-a131-4ae2-b2b0-9aec16e9f77b`. The key is already `anthropic`, so that write is skipped. The account id comes from the staging site. Production `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` is refused. `--dry-run` and `--diagnose` only report that setting and, by name, whether `OI_RECOGNITION_ENABLED` and `ANTHROPIC_API_KEY` are present. They do not print values and they do not write env. The live release before this attempt is r51, app `5d1c899e1f79f72c79786093840e8909d4d39924`. Its deploy id is not recorded in this repository. Rollback stays r36 `6af230ff9978904131f1329d`. r40 `6af2529a86a3086b06adeeba`, r41 `6af25e04dc82ddde9d4b7faf`, r42 `6af267f996f701055ad0e622`, and r45 `6af3327ee97e40701b3c6e87` are known good. Do not restore r37 `6af23d43d233389a2238082e` or r31 `6af1f35de6630ee7fa2d39fe`. Do not run it again if the attempt file already exists, and do not restore automatically.

Rollback is redeploying that recorded deploy in the Netlify UI for this staging site only. Do not delete it.
