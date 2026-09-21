// Free local verification only. PGlite's socket adapter needs one pooled
// connection; this is not a substitute for multi-client connected staging.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'oi-video-test-'));
const preload = join(dir, 'single-pool.cjs');
await writeFile(preload, `const pg=require(${JSON.stringify(require.resolve('pg'))});const Pool=pg.Pool;pg.Pool=class extends Pool{constructor(o){super({...o,max:1,idleTimeoutMillis:0});}};`);
const db = await PGlite.create({ extensions: { pgcrypto } });
const port = 55441;
const server = new PGLiteSocketServer({ db, port, host:'127.0.0.1' });
let status=1;
try {
 await server.start();
 const selected = process.argv.slice(2);
 const tests = selected.length ? selected : ['tests/offlineSyncApi.test.ts','tests/rolePermissions.test.ts','tests/batchQrCodes.test.ts','tests/openingQr.test.ts'];
 if(tests.some(p=>!/^tests\/[\w.-]+\.test\.ts$/.test(p)))throw new Error('Only explicit local test files are accepted');
 const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',...tests],{stdio:'inherit',env:{...process.env,NODE_OPTIONS:`--require ${preload}`,OI_PGLITE_TEST:'1',TEST_DATABASE_URL:`postgres://postgres:postgres@127.0.0.1:${port}/oi_connected_video_test`}});
 status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
} finally {await server.stop();await db.close();await rm(dir,{recursive:true,force:true});}
process.exit(status);
