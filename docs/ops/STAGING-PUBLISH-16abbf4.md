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

The build prints `packageSha256`. Do not rebuild if that value is still `ab779e93cffb8f8958dbf95409dcad60891ae3e96281a2ad3809494b40bb3c2d`. The dry run writes `dist/staging-publish-journal-16abbf4-r2/publication-dry-run.json`. It should say `package_checksum_matched`, `productionRefused: true`, and a `rollbackDeployId`. It does not upload. Leave the earlier `dist/staging-publish-journal-16abbf4/` directory untouched.

```
node scripts/artifact-publisher-staging-16abbf4.mjs --dry-run
```

The Netlify CLI install is loaded from `C:\Users\spols\Documents\Codex\2026-10-23\task\.local-netlify-cli\node_modules\netlify-cli` (v27.14.2). Pass `--netlify-cli-dir` only if that folder moved. The publisher uses that install's dev-utils to confirm the logged-in account and to take an in-memory token. The token is not printed or written. Requests go only to `api.netlify.com` for site `b64bf33c-a131-4ae2-b2b0-9aec16e9f77b` and for the deploy id this run creates. `auth_required` and `auth_account_mismatch` are login problems. `deploy_create_failed`, `deploy_upload_failed`, `deploy_poll_failed`, `deploy_not_ready`, and `deploy_publish_failed` are upload problems. A failure also writes `failure.json` in the new journal directory with the sanitized response body. The attempt file is `dist/staging-publish-journal-16abbf4-r2/publication-attempt.json`. The upload creates a draft with file and function digests, uploads only what Netlify marks required, waits until the deploy is ready, then publishes it. It does not run `netlify deploy`.

When the dry run looks right:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --publish-approved
```

Rollback is redeploying that recorded deploy in the Netlify UI for this staging site only. Do not delete it.
