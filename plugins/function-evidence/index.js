const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createEvidence} = require('./evidence.cjs');

module.exports = {
  async onPostBuild({constants}) {
    const {assertIsolatedReleaseContext} = await import('../../scripts/isolated-release-context.mjs');
    assertIsolatedReleaseContext(process.env);
    const evidence = createEvidence(constants.FUNCTIONS_DIST, {
      commit:process.env.COMMIT_REF, deployId:process.env.DEPLOY_ID, context:process.env.CONTEXT,
    });
    const bytes = JSON.stringify(evidence, null, 2) + '\n';
    fs.writeFileSync(path.join(constants.PUBLISH_DIR, 'function-package-evidence.json'), bytes);
    console.log('OI_FUNCTION_PACKAGE_EVIDENCE ' + JSON.stringify(evidence));
    console.log('OI_FUNCTION_PACKAGE_MANIFEST_SHA256 ' + createHash('sha256').update(bytes).digest('hex'));
  },
};
