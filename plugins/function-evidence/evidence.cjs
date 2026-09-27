const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

function createEvidence(directory, identity) {
  if (!/^[a-f0-9]{40}$/.test(identity.commit || '') ||
      !/^[a-f0-9]{24}$/.test(identity.deployId || '')) throw new Error('Missing build identity');
  const artifacts = {};
  for (const name of ['api', 'photo-deletion-retry']) {
    const file = path.join(directory, name + '.zip');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected packaged function ZIP: ' + name);
    const bytes = fs.readFileSync(file);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid function ZIP: ' + name);
    artifacts[name] = {bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  return {schemaVersion:1, ...identity, source:'Netlify onPostBuild FUNCTIONS_DIST packaged ZIP bytes',
    qualification:'Build-side package evidence, not an independent download of running Lambda bytes', artifacts};
}
module.exports = {createEvidence};
