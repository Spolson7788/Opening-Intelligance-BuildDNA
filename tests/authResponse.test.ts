import {describe,it,expect} from 'vitest';
import {loginFailureMessage,recoveryResponse} from '../field-app/src/lib/authResponse';

describe('authentication response provenance',()=>{
 it('does not call hosting 401/403 a password rejection or deactivated account',()=>{
  for(const status of [401,403]) expect(loginFailureMessage(status,'login_failed')).toContain('Site access could not be verified');
 });
 it('reports actual application credential and account decisions',()=>{
  const ref='49ceec1e-eaef-4c2b-99b8-46bb7770fe8c';
  expect(loginFailureMessage(401,'invalid_credentials',ref)).toContain("didn't match");
  expect(loginFailureMessage(403,'account_deactivated',ref)).toContain('deactivated');
  expect(loginFailureMessage(401,'login_failed',ref)).toContain('Site access');
 });
 it('never calls an HTML access page a successful reset, even with HTTP 200',async()=>{
  for(const status of [200,400,401,403]){
   const result=await recoveryResponse(new Response('<html>Sign in</html>',{status,headers:{'content-type':'text/html'}}));
   expect(result.saved).toBe(false);
   expect(result.message).toContain(`HTTP ${status}`);
  }
 });
 it('distinguishes genuine reset success, invalid code, and service failure',async()=>{
  const read=(status:number,body:object)=>recoveryResponse(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
  expect((await read(200,{message:'Password saved. Sign in with the password you just chose.'})).saved).toBe(true);
  expect((await read(200,{})).saved).toBe(false);
  expect((await read(400,{error:'invalid_or_expired_code'})).message).toContain('invalid, expired');
  expect((await read(503,{error:'recovery_unavailable'})).message).toContain('HTTP 503');
 });
});
