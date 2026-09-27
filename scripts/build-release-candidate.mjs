// Offline packaging only. Does not migrate, configure a service, or deploy.
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildFacilityDashboard} from './build-facility-dashboard.mjs';

const root=resolve(import.meta.dirname,'..');
if(process.env.NETLIFY==='true')throw Error('Release candidate packaging is offline only; it cannot publish a Netlify build.');
const output=resolve(root,'dist/release-candidate');
if(existsSync(output))throw Error('Preserve the existing candidate before building a replacement.');
const npm=process.platform==='win32'?'npm.cmd':'npm';
for(const app of ['', 'field-app','dashboard']) {
 const args=app?['run','build','--','--base',app==='field-app'?'/field/':'/dashboard/']:['run','build'];
 execFileSync(npm,args,{cwd:resolve(root,app),stdio:'inherit',env:{...process.env,OI_UI_BASE:app==='field-app'?'/field/':'/dashboard/',VITE_API_BASE_URL:'/api'}});
}
mkdirSync(output,{recursive:true});
const web=resolve(output,'web');mkdirSync(web);
cpSync(resolve(root,'field-app/dist'),resolve(web,'field'),{recursive:true});
cpSync(resolve(root,'dashboard/dist'),resolve(web,'dashboard'),{recursive:true});
buildFacilityDashboard(resolve(web,'facility-dashboard'));
writeFileSync(resolve(web,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><title>Opening Intelligence release candidate</title><body><h1>Opening Intelligence</h1><p>Unapproved release candidate — synthetic testing only.</p><a href="/field/scan">Field App</a> · <a href="/facility-dashboard/">Facility Dashboard</a></body></html>');
writeFileSync(resolve(web,'_redirects'),'/field/* /field/index.html 200\n/dashboard/* /dashboard/index.html 200\n');
// Keep server material separate from the published web directory.
mkdirSync(resolve(output,'server'));
for(const entry of readdirSync(resolve(root,'dist'),{withFileTypes:true})){
 if(entry.name==='release-candidate'||entry.name==='protected-staging'||entry.name.startsWith('staging-build-')||entry.name.startsWith('previous-staging-'))continue;
 cpSync(resolve(root,'dist',entry.name),resolve(output,'server',entry.name),{recursive:true});
}
const artifacts={};
function inventory(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())inventory(path);else {const bytes=readFileSync(path);artifacts[relative(output,path)]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}}}
inventory(output);
writeFileSync(resolve(output,'manifest.json'),JSON.stringify({status:'NOT APPROVED FOR PRODUCTION',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),artifacts,remainingGates:['Isolated production backend and account enrollment','Recognition provider integration acceptance','Legacy scheduled-function disposition','Production security review and rollback rehearsal','Explicit production release approval']},null,2)+'\n');
console.log('Offline release candidate assembled. No deployment or database changes performed.');
