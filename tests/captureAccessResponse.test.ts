import {escapedGateHtml} from './fixtures/netlifyGate';
import {afterEach,expect,it,vi} from 'vitest';
import {isNetlifyAccessResponse,siteAccessRenewalUrl,SITE_ACCESS_REQUIRED} from '../field-app/src/lib/siteAccess';
import {openingLoadFailure} from '../field-app/src/lib/openingLoadFailure';
vi.mock('../field-app/src/lib/db',()=>({loadAuth:vi.fn(async()=>({userId:'a',organizationId:'ca',token:'MOCK'})),cacheOpening:vi.fn(),getCachedOpening:vi.fn()}));
import {fetchPhotoAccessUrl} from '../field-app/src/lib/api';
const html='<html><title>Login Redirect</title><script>window.location.href="https://app.netlify.com/edge-access?domain=oi-connected-release-candidate.netlify.app";</script></html>';
afterEach(()=>vi.unstubAllGlobals());
it('recognizes only the known HTML 401 candidate access response',()=>{
  expect(isNetlifyAccessResponse(401,'text/html; charset=utf-8',html)).toBe(true);
  for(const [status,type,text] of [[403,'text/html',html],[401,'application/json',html],[401,'text/html','unrelated'],[401,'text/html',html.replace('app.netlify.com/','app.netlify.com.evil/')] ] as const)expect(isNetlifyAccessResponse(status,type,text)).toBe(false);
});
it('uses only a fixed official renewal URL for the exact candidate origin',()=>{
  expect(siteAccessRenewalUrl('https://oi-connected-release-candidate.netlify.app')).toBe('https://app.netlify.com/edge-access?domain=oi-connected-release-candidate.netlify.app');
  for(const origin of ['https://customer.example','https://oi-connected-release-candidate.netlify.app.evil','http://oi-connected-release-candidate.netlify.app'])expect(siteAccessRenewalUrl(origin)).toBeNull();
});
it('classifies HTML through the real API wrapper without executing or exposing it',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(html+'SECRET',{status:401,headers:{'content-type':'text/html'}})));
  const error=await fetchPhotoAccessUrl('test').catch(e=>e);
  expect(error.message).toBe(SITE_ACCESS_REQUIRED);
  expect(openingLoadFailure(error)).toMatchObject({siteAccess:true,signIn:false});
  expect(JSON.stringify(error)).not.toContain('SECRET');
});
it('keeps JSON invalid_token as application sign-in failure',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'invalid_token'}),{status:401,headers:{'content-type':'application/json'}})));
  const error=await fetchPhotoAccessUrl('test').catch(e=>e);
  expect(error.message).toBe('invalid_token');expect(openingLoadFailure(error).signIn).toBe(true);
});
it('unexpected HTML is not a password rejection and never leaks response content',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>SECRET</html>',{status:401,headers:{'content-type':'text/html'}})));
  const error=await fetchPhotoAccessUrl('test').catch(e=>e);
  expect(error.message).toBe('unexpected_response');expect(openingLoadFailure(error).signIn).toBe(false);
  expect(JSON.stringify(error)).not.toContain('SECRET');
});

it('recognizes the escaped-slash Netlify response without weakening gates',async()=>{
  expect(isNetlifyAccessResponse(401,'text/html; charset=utf-8',escapedGateHtml)).toBe(true);
  for(const body of [escapedGateHtml.replace('app.netlify.com','attacker.example'),escapedGateHtml.replace("netlify.app'","netlify.app.evil'"),'<title>Login Redirect</title><p>unrelated</p>'])expect(isNetlifyAccessResponse(401,'text/html',body)).toBe(false);
  expect(isNetlifyAccessResponse(403,'text/html',escapedGateHtml)).toBe(false);
  expect(isNetlifyAccessResponse(401,'application/json',escapedGateHtml)).toBe(false);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(escapedGateHtml+'SECRET',{status:401,headers:{'content-type':'text/html'}})));
  const error=await fetchPhotoAccessUrl('test').catch(e=>e);
  expect(error.message).toBe(SITE_ACCESS_REQUIRED);expect(openingLoadFailure(error)).toMatchObject({siteAccess:true,signIn:false});
  expect(JSON.stringify(error)).not.toContain('SECRET');
});
