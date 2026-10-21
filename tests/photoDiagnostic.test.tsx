import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {classifyPhotoProbe,diagnosticActor,diagnosticAvailable,OPENING,PHOTO,PROBES,readBoundedProbe,runPhotoProbes} from '../field-app/src/lib/photoDiagnostic';
const state=vi.hoisted(()=>({auth:{userId:'test-a',organizationId:'44b157d8-acf7-408c-a833-c83f5c4b09bc',role:'technician',token:'MOCK-NEVER-OUTPUT'}}));
vi.mock('../field-app/src/lib/db',()=>({loadAuth:vi.fn(async()=>state.auth),cacheOpening:vi.fn(),getCachedOpening:vi.fn()}));
vi.mock('../field-app/src/lib/AuthContext',()=>({useAuth:()=>({auth:state.auth,loading:false})}));
import {runCandidatePhotoDiagnostic} from '../field-app/src/lib/api';
import PhotoIsolationPage from '../field-app/src/pages/PhotoIsolationPage';
import {writeFileSync} from 'node:fs';
import {photoIsolationBuildEnabled} from '../field-app/photoDiagnosticBuild';
const response=(status:number,data:unknown)=>({status,data,contentType:'application/json',redirected:false});
const principal=()=>({userId:state.auth.userId,organizationId:state.auth.organizationId,role:state.auth.role});
beforeEach(()=>{state.auth={userId:'test-a',organizationId:'44b157d8-acf7-408c-a833-c83f5c4b09bc',role:'technician',token:'MOCK-NEVER-OUTPUT'};vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);});
afterEach(()=>vi.unstubAllGlobals());
it('build inclusion requires exact candidate site, branch and production context',()=>{
  const env={NETLIFY:'true',SITE_ID:'80fbbee8-b9d3-4b16-b93f-d2d8396591ec',CONTEXT:'production',BRANCH:'release/connected-candidate'};
  expect(photoIsolationBuildEnabled(env)).toBe(true);
  for(const delta of [{SITE_ID:'customer-production'},{CONTEXT:'deploy-preview'},{BRANCH:'main'},{NETLIFY:'false'}])expect(photoIsolationBuildEnabled({...env,...delta})).toBe(false);
  expect(photoIsolationBuildEnabled({})).toBe(false);
});
it('gates exact origin, relative API, technician and known organization',()=>{
  expect(diagnosticAvailable(true,window.location.origin,'/api')).toBe(true);
  expect(diagnosticAvailable(false,window.location.origin,'/api')).toBe(false);
  expect(diagnosticAvailable(true,'https://customer.example','/api')).toBe(false);
  expect(diagnosticAvailable(true,window.location.origin,'https://external.example/api')).toBe(false);
  expect(diagnosticActor({...principal(),role:'admin'})).toBe(null);
  expect(diagnosticActor({...principal(),organizationId:'unknown'})).toBe(null);
});
it('classifies the two A successes and B refusals',()=>{
  expect(classifyPhotoProbe('A',0,response(200,[{id:PHOTO,opening_id:OPENING}])).verdict).toBe('PASS');
  expect(classifyPhotoProbe('A',1,response(200,{url:'https://storage.invalid/?secret=SECRET',expires_in_seconds:300})).verdict).toBe('PASS');
  expect(classifyPhotoProbe('B',0,response(403,{error:'forbidden'})).verdict).toBe('PASS');
  expect(classifyPhotoProbe('B',1,response(404,{error:'not_found'})).verdict).toBe('PASS');
});
it('401, HTML, redirect, wrong error, leaked body, unexpected data cannot pass',()=>{
  for(const r of [response(401,{}),{...response(403,{error:'forbidden'}),contentType:'text/html'},{...response(403,{error:'forbidden'}),redirected:true},response(302,{}),response(403,{error:'not_found'}),response(403,{error:'forbidden',url:'SECRET'}),response(200,[])])expect(classifyPhotoProbe('B',0,r).verdict).not.toBe('PASS');
  expect(classifyPhotoProbe('A',0,response(200,[{id:PHOTO,opening_id:'other'}])).verdict).toBe('FAIL');
  expect(classifyPhotoProbe('A',1,response(200,{url:'http://storage.invalid',expires_in_seconds:300})).verdict).toBe('FAIL');
});
it('never returns raw data, error text or URLs; stops after first failure',async()=>{
  const request=vi.fn(async()=>{throw Error('SECRET token private url')});
  const result=await runPhotoProbes('A',request);
  expect(request).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(JSON.stringify(classifyPhotoProbe('A',1,response(200,{url:'https://storage.invalid/?secret=SECRET',expires_in_seconds:300})))).not.toContain('SECRET');
});
it('uses existing authenticated wrapper, exactly two pinned GETs, no redirects or storage fetch',async()=>{
  const network=vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/access')?{url:'https://storage.invalid/?secret=SECRET',expires_in_seconds:300}:[{id:PHOTO,opening_id:OPENING}]),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',network);
  const result=await runCandidatePhotoDiagnostic(principal());expect(result.every(r=>r.verdict==='PASS')).toBe(true);
  expect(network.mock.calls.map(c=>c[0])).toEqual(PROBES.map(p=>'/api'+p));
  for(const call of network.mock.calls as unknown as [string,RequestInit][]){expect(call[1].method).toBe('GET');expect(call[1].redirect).toBe('error');expect(call[1].cache).toBe('no-store');expect(call[1].body).toBeUndefined();}
  expect(JSON.stringify(result)).not.toMatch(/SECRET|MOCK-NEVER-OUTPUT|storage.invalid/);
});
it('B refusals pass through wrapper and no unauthenticated response passes',async()=>{
  state.auth.organizationId='fb7f7867-aa5c-497f-9dc0-b400fbc1ce31';
  const network=vi.fn(async(url:string)=>new Response(JSON.stringify({error:url.endsWith('/access')?'not_found':'forbidden'}),{status:url.endsWith('/access')?404:403,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',network);
  expect((await runCandidatePhotoDiagnostic(principal())).map(r=>r.verdict)).toEqual(['PASS','PASS']);
  network.mockImplementation(async()=>new Response('{}',{status:401,headers:{'content-type':'application/json'}}));
  expect((await runCandidatePhotoDiagnostic(principal()))[0].verdict).toBe('INCONCLUSIVE');
});
it('principal change during a failed response is inconclusive and stops',async()=>{
  const network=vi.fn(async()=>{state.auth={...state.auth,userId:'other'};return new Response('{"error":"forbidden"}',{status:403,headers:{'content-type':'application/json'}})});vi.stubGlobal('fetch',network);
  expect((await runCandidatePhotoDiagnostic(principal()))[0].verdict).toBe('INCONCLUSIVE');expect(network).toHaveBeenCalledTimes(1);
});
it('oversized and malformed JSON responses are refused',async()=>{
  await expect(readBoundedProbe(new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}}))).rejects.toThrow();
  await expect(readBoundedProbe(new Response('not json',{headers:{'content-type':'application/json'}}))).rejects.toThrow();
});
it('page renders readable safe results, requires confirmation, cannot run twice',async()=>{
  const network=vi.fn(async()=>new Response('{"error":"SECRET"}',{status:500,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',network);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<PhotoIsolationPage/>));
    const button=host.querySelector('button')!;expect(button.disabled).toBe(true);expect(network).not.toHaveBeenCalled();
    await act(async()=>host.querySelector('input')!.click());expect(button.disabled).toBe(false);
    await act(async()=>button.click());
    expect(host.textContent).toContain('Photo list: FAIL');expect(host.textContent).toContain('HTTP 500');
    expect(host.textContent).not.toMatch(/SECRET|MOCK-NEVER-OUTPUT/);expect(button.disabled).toBe(true);
    // Optional static screenshot fixture of actual React-rendered markup. No scripts or requests.
    if(process.env.OI_DIAGNOSTIC_PREVIEW==='true')writeFileSync('diagnostic-ui-preview.html','<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local diagnostic preview - mocked result</title><style>body{font-family:system-ui;background:#14171a;color:#f4f4f4}button{font:inherit}h1{font-size:28px}h2{font-size:21px}</style><body><p>LOCAL MOCK PREVIEW - no live requests</p>'+host.innerHTML+'</body></html>');
    await act(async()=>button.click());expect(network).toHaveBeenCalledTimes(1);
  } finally {await act(async()=>root.unmount());host.remove();}
});
