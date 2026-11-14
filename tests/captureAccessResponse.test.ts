import {escapedGateHtml} from './fixtures/netlifyGate';
import {afterEach,expect,it,vi} from 'vitest';
import {isNetlifyAccessResponse,siteAccessRenewalUrl,SITE_ACCESS_REQUIRED} from '../field-app/src/lib/siteAccess';
import {openingLoadFailure} from '../field-app/src/lib/openingLoadFailure';
vi.mock('../field-app/src/lib/db',()=>({loadAuth:vi.fn(async()=>({userId:'a',organizationId:'ca',token:'MOCK'})),clearAuth:vi.fn(async()=>{}),cacheOpening:vi.fn(),getCachedOpening:vi.fn()}));
import {fetchPhotoAccessUrl} from '../field-app/src/lib/api';
const html='<html><title>Login Redirect</title><script>window.location.href="https://app.netlify.com/edge-access?domain=oi-connected-release-candidate.netlify.app";</script></html>';
it('supports exact isolated staging gate and rejects hostile origin variants',()=>{
  const origin='https://oi-video-workflows-staging.netlify.app';
  const gate=html.replaceAll('oi-connected-release-candidate','oi-video-workflows-staging');
  expect(isNetlifyAccessResponse(401,'text/html',gate)).toBe(true);
  expect(siteAccessRenewalUrl(origin)).toBe(`${origin}/`);
  for(const bad of [origin+'.evil',origin+':443',origin+'/',origin+'@evil.example',origin.replace('https:','http:')])expect(siteAccessRenewalUrl(bad)).toBeNull();
  for(const bad of [gate.replace('staging.netlify.app','staging.netlify.app.evil'),gate.replace('app.netlify.com/','app.netlify.com.evil/')])expect(isNetlifyAccessResponse(401,'text/html',bad)).toBe(false);
  expect(isNetlifyAccessResponse(403,'text/html',gate)).toBe(false);
  expect(isNetlifyAccessResponse(401,'application/json',gate)).toBe(false);
});
afterEach(()=>vi.unstubAllGlobals());
it('recognizes only the exact encoded ampersand boundary on both supported gates',async()=>{
  for(const host of ['oi-connected-release-candidate.netlify.app','oi-video-workflows-staging.netlify.app']) {
    // Synthetic reproduction: no actual redirect parameters or credentials.
    const prefix=String.raw`<title>Login Redirect</title><script>location="https:\/\/app.netlify.com\/edge-access?domain=${host}`;
    const encoded=prefix+String.raw`\u0026synthetic=1";</script>`;
    const ordinary=prefix+'&synthetic=1";</script>';
    for(const body of [encoded,ordinary])expect(isNetlifyAccessResponse(401,'text/html; charset=utf-8',body)).toBe(true);
    for(const suffix of [String.raw`\u002`,String.raw`\u0027`,String.raw`\u002G`,String.raw`\U0026`,String.raw`%26`,String.raw`.evil\u0026`])
      expect(isNetlifyAccessResponse(401,'text/html',prefix+suffix+'synthetic=1";</script>')).toBe(false);
    for(const body of [encoded.replace('app.netlify.com','app.netlify.com.evil'),encoded.replace('/edge-access?','/other?'),encoded.replace('https:','http:'),encoded.replace('<title>Login Redirect</title>',''),encoded.replace(host,host+'.evil')])
      expect(isNetlifyAccessResponse(401,'text/html',body)).toBe(false);
    for(const [status,mime] of [[403,'text/html'],[401,'application/json'],[403,'application/json'],[401,'']] as const)
      expect(isNetlifyAccessResponse(status,mime,encoded)).toBe(false);
    const fetchMock=vi.fn(async()=>new Response(encoded,{status:401,headers:{'content-type':'text/html'}}));
    vi.stubGlobal('fetch',fetchMock);
    const error=await fetchPhotoAccessUrl('synthetic').catch(e=>e);
    expect(error.message).toBe(SITE_ACCESS_REQUIRED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain('synthetic=1');
  }
});
it('recognizes only the known HTML 401 candidate access response',()=>{
  expect(isNetlifyAccessResponse(401,'text/html; charset=utf-8',html)).toBe(true);
  for(const [status,type,text] of [[403,'text/html',html],[401,'application/json',html],[401,'text/html','unrelated'],[401,'text/html',html.replace('app.netlify.com/','app.netlify.com.evil/')] ] as const)expect(isNetlifyAccessResponse(status,type,text)).toBe(false);
});
it('uses only a fixed official renewal URL for the exact candidate origin',()=>{
  expect(siteAccessRenewalUrl('https://oi-connected-release-candidate.netlify.app')).toBe('https://oi-connected-release-candidate.netlify.app/');
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
it('keeps genuine JSON forbidden responses as access refusal',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'forbidden'}),{status:403,headers:{'content-type':'application/json'}})));
  const error=await fetchPhotoAccessUrl('test').catch(e=>e);
  expect(error.status).toBe(403);expect(error.message).toBe('forbidden');
  expect(openingLoadFailure(error)).toMatchObject({title:'Access unavailable',retry:false});
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
