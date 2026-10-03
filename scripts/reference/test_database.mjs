// Local-only PostgreSQL-compatible fixture harness. No hosted/model calls.
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {spawn} from 'node:child_process';
const db=await PGlite.create({extensions:{pgcrypto}});
await db.exec('CREATE ROLE oi_pr2_api; CREATE ROLE oi_reference_editor; CREATE ROLE oi_reference_approver;');
const server=new PGLiteSocketServer({db,port:55432,host:'127.0.0.1',maxConnections:10});
await server.start();
try{
 const selected=process.argv.slice(2);
 const files=selected.length?selected:['tests/referenceEvidence.test.ts','tests/recognitionRelease.test.ts','tests/offlineSyncApi.test.ts','tests/pairedOpenings.test.ts','tests/providerPurchasing.test.ts'];
 const child=spawn('npx',['vitest','run',...files],{stdio:'inherit',env:{...process.env,OI_PGLITE_TEST:'1',TEST_DATABASE_URL:'postgres://postgres:postgres@127.0.0.1:55432/postgres'}});
 process.exitCode=await new Promise(resolve=>child.on('exit',resolve));
}finally{await server.stop();await db.close();}
