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

The build prints `packageSha256`. The dry run writes `dist/staging-publish-journal-16abbf4/publication-dry-run.json` and does not contact Netlify. It should say `package_checksum_matched` and `productionRefused: true`.

When that dry run looks right, and only then:

```
node scripts/artifact-publisher-staging-16abbf4.mjs --publish-approved
```

That command needs a Netlify login already available to the Netlify CLI (`NETLIFY_AUTH_TOKEN` or an existing `netlify login`). It does not print the token. The attempt journal is `dist/staging-publish-journal-16abbf4/publication-attempt.json`. A ready journal has `state` `ready`, the new deploy id, and `rollbackDeployId` for the deploy that was live before this one.

Rollback is redeploying that recorded deploy in the Netlify UI for this staging site only. Do not delete it.
