import {it,expect,vi} from 'vitest';
const probes=vi.hoisted(()=>({create:vi.fn(()=>({})),adapt:vi.fn(()=>async()=>new Response('ok'))}));
vi.mock('../src/app',()=>({createApp:probes.create}));
vi.mock('../netlify/functions/_shared/expressAdapter',()=>({netlifyExpressAdapter:probes.adapt}));
import handler from '../netlify/functions/api';
it('passes trusted platform context, never request-controlled identity',async()=>{
  const context={site:{id:'trusted-site'},deploy:{id:'trusted-deploy',context:'production'}};
  await handler(new Request('https://example.invalid/api/staging-storage-comparison',{headers:{'x-site-id':'forged','x-deploy-id':'forged'}}),context as any);
  expect(probes.create).toHaveBeenLastCalledWith(expect.objectContaining({diagnosticPlatform:{siteId:'trusted-site',deployId:'trusted-deploy',context:'production'}}));
});
it('passes missing platform identity as undefined so the router fails closed',async()=>{
  await handler(new Request('https://example.invalid/api/staging-storage-comparison'),{} as any);
  expect(probes.create).toHaveBeenLastCalledWith(expect.objectContaining({diagnosticPlatform:{siteId:undefined,deployId:undefined,context:undefined}}));
});
