import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import previewAccess from '../netlify/functions/preview-access';
import {isUnverifiedSiteAccess, PREVIEW_ACCESS_EVENT} from '../field-app/src/lib/previewAccess';

vi.mock('../field-app/src/lib/db', () => ({
  loadAuth: vi.fn(async () => ({token: 'test-only', userId: 'user', organizationId: 'org'})),
  cacheOpening: vi.fn(), getCachedOpening: vi.fn(),
}));
import {checkPreviewAccess, login, recognizeHardware} from '../field-app/src/lib/api';

const ref = '49ceec1e-eaef-4c2b-99b8-46bb7770fe8c';
const json = (status: number, body: object) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json'},
});

describe('private preview recovery without replaying writes', () => {
  let requests: ReturnType<typeof vi.fn>;
  let renewalEvents: number;
  beforeEach(() => {
    requests = vi.fn(); vi.stubGlobal('fetch', requests);
    const page = new EventTarget(); renewalEvents = 0;
    page.addEventListener(PREVIEW_ACCESS_EVENT, () => renewalEvents++);
    vi.stubGlobal('window', page);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([401, 403])('stops a hosting %s before sign-in and offers renewal', async status => {
    requests.mockResolvedValue(new Response('<html>Login Redirect</html>', {status, headers: {'Content-Type': 'text/html'}}));
    await expect(checkPreviewAccess()).rejects.toMatchObject({status, hostingAccessRequired: true});
    expect(renewalEvents).toBe(1);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls[0]).toEqual(['/health', {credentials: 'same-origin', cache: 'no-store'}]);
  });
  it('allows sign-in after a successful server access check', async () => {
    requests.mockResolvedValueOnce(json(200, {status: 'ok'})).mockResolvedValueOnce(json(200, {token: 'test-token', expiresIn: '12h'}));
    await checkPreviewAccess();
    expect(await login('qa@example.test', 'test-only-password')).toMatchObject({token: 'test-token'});
    expect(renewalEvents).toBe(0);
  });
  it('does not call a real wrong-password decision a hosting failure', async () => {
    requests.mockResolvedValue(json(401, {error: 'invalid_credentials', reference: ref}));
    await expect(login('qa@example.test', 'wrong-test-password')).rejects.toMatchObject({status: 401, message: 'invalid_credentials', reference: ref, hostingAccessRequired: false});
    expect(renewalEvents).toBe(0);
  });
  it('stops recognition on a hosting refusal without automatically sending the photo again', async () => {
    requests.mockResolvedValue(new Response('<html>Login Redirect</html>', {status: 401, headers: {'Content-Type': 'text/html'}}));
    await expect(recognizeHardware('synthetic-opening', ['AAAA'], 'image/png')).rejects.toMatchObject({hostingAccessRequired: true});
    expect(requests).toHaveBeenCalledTimes(1);
    expect(renewalEvents).toBe(1);
  });
  it.each(['invalid_token', 'session_revoked', 'account_deactivated', 'forbidden'])('keeps application %s decisions separate', async code => {
    requests.mockResolvedValue(json(code === 'forbidden' || code === 'account_deactivated' ? 403 : 401, {error: code}));
    await expect(recognizeHardware('synthetic-opening', ['AAAA'], 'image/png')).rejects.toMatchObject({message: code, hostingAccessRequired: false});
    expect(renewalEvents).toBe(0);
  });
  it('does not turn an outage into a sign-in renewal', async () => {
    requests.mockResolvedValue(json(503, {error: 'reference_staging_not_configured'}));
    await expect(checkPreviewAccess()).rejects.toMatchObject({hostingAccessRequired: false, status: 503});
    expect(renewalEvents).toBe(0);
  });
  it('does not accept an HTML response as a successful health check', async () => {
    requests.mockResolvedValue(new Response('<html>Sign in</html>', {status: 200, headers: {'Content-Type': 'text/html'}}));
    await expect(checkPreviewAccess()).rejects.toMatchObject({status: 503});
  });
});

describe('network-only access navigation', () => {
  it('returns to the same-site sign-in without trusting a supplied destination', async () => {
    const response = await previewAccess(new Request('https://staging.example.test/preview-access?return_to=https://evil.example'));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/field/login?preview_access=renewed');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('never handles a credential POST', async () => {
    const response = await previewAccess(new Request('https://staging.example.test/preview-access', {method: 'POST', body: 'test-only'}));
    expect(response.status).toBe(405);
    expect(response.headers.get('Location')).toBeNull();
  });
  it('requires renewal for uncorrelated hosting refusals only', () => {
    expect(isUnverifiedSiteAccess(new Response(null, {status: 401}), null)).toBe(true);
    expect(isUnverifiedSiteAccess(json(403, {error: 'forbidden'}), {error: 'forbidden'})).toBe(false);
  });
});

it('recovers the exact saved analysis after a gateway timeout without replaying the photo POST',async()=>{
 const calls: {url:string;options:any}[]=[];
 const recovery=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{
  calls.push({url,options});
  if(options.method==='POST')return json(504,{error:'request_failed_504'});
  const requestId=JSON.parse(calls[0].options.body).request_id;
  expect(url).toContain(`/request/${requestId}?opening_id=synthetic-opening`);
  return json(200,{request_id:requestId,run_id:'saved-run',suggestion:{model:'fixture'},recovered:true});
 }));
 try{
  const result=await recognizeHardware('synthetic-opening',['AAAA'],'image/png',{},recovery);
  expect(result.run_id).toBe('saved-run');expect(recovery).toHaveBeenCalledOnce();
  expect(calls.filter(c=>c.options.method==='POST')).toHaveLength(1);
  expect(calls[1].options.body).toBeUndefined();
 }finally{vi.unstubAllGlobals();}
});
it('rejects a recovered result belonging to a different request',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(json(504,{})).mockResolvedValueOnce(json(200,{request_id:'different',run_id:'wrong-run'})));
 try{await expect(recognizeHardware('synthetic-opening',['AAAA'],'image/png')).rejects.toMatchObject({message:'recognition_recovery_invalid_response'});}finally{vi.unstubAllGlobals();}
});
