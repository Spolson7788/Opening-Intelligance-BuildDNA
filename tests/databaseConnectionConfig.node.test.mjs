import {test} from 'node:test';
import assert from 'node:assert/strict';
import {X509Certificate} from 'node:crypto';
import {databaseConnectionConfig} from '../src/db/connectionConfig.ts';
const ref='ioqfdcehnhnqpnqawwvo';
const direct=`postgresql://role:fixture@db.${ref}.supabase.co/postgres`;
const pooler=`postgresql://role.${ref}:fixture@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;
test('staging direct and pooler use validated public CA with hostname verification',()=>{
 for(const DATABASE_URL of [direct,pooler]){
  const c=databaseConnectionConfig({DATABASE_URL,DATABASE_CA_CERT:'malformed-input'});
  assert.equal(c.ssl.rejectUnauthorized,true);
  const cert=new X509Certificate(c.ssl.ca);
  assert.equal(cert.ca,true);
  assert.equal(cert.fingerprint256.replaceAll(':','').toLowerCase(),'807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa');
 }
});
test('staging TLS is enabled even when environment CA is absent',()=>{
 assert.equal(databaseConnectionConfig({DATABASE_URL:pooler}).ssl.rejectUnauthorized,true);
});
test('other database targets retain invalid-CA refusal',()=>{
 for(const DATABASE_URL of ['postgresql://role:fixture@localhost/postgres','postgresql://role:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres','postgresql://role.aaaaaaaaaaaaaaaaaaaa:fixture@aws-0-us-west-1.pooler.supabase.com/postgres'])
 assert.throws(()=>databaseConnectionConfig({DATABASE_URL,DATABASE_CA_CERT:'malformed-input'}),/database_ca_certificate_invalid/);
});
test('local database configuration stays unchanged',()=>{
 assert.deepEqual(databaseConnectionConfig({DATABASE_URL:'postgresql://localhost/test'}),{connectionString:'postgresql://localhost/test'});
});
test('staging does not accept TLS weakening URL options',()=>{
 for(const options of ['sslmode=require','sslmode=disable','ssl=false','uselibpqcompat=true','sslrootcert=other'])
 assert.throws(()=>databaseConnectionConfig({DATABASE_URL:pooler+'?'+options}),/database_tls_configuration_conflict/);
});
test('verify-full URL retains explicit validated CA',()=>{
 const c=databaseConnectionConfig({DATABASE_URL:pooler+'?sslmode=verify-full'});
 assert.equal(c.ssl.rejectUnauthorized,true);
 assert.equal(new URL(c.connectionString).searchParams.has('sslmode'),false);
});
