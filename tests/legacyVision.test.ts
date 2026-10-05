// Unit boundary: provider/audit integration is covered by recognitionAuditApi and recognitionFixes.
vi.mock('../src/services/recognitionAudit',()=>({auditedFetch:(url:string,init:RequestInit)=>fetch(url,init),recordRecognitionEvidence:vi.fn()}));
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {legacyVisionHandler} from '../src/services/legacyVision';
const fetchMock=vi.fn();
const event={httpMethod:'POST',body:JSON.stringify({images:['/9j/AA=='],media_type:'image/jpeg',mode:'identify'})};
beforeEach(()=>{vi.stubEnv('ANTHROPIC_API_KEY','test-not-real');vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function provider(result:unknown){fetchMock.mockResolvedValue(new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify(result)}]}),{status:200}));}
describe('real recognition engine response handling',()=>{
 it('returns an ordinary identification instead of crashing after a successful provider response',async()=>{provider({component_class:'LOCKSET',manufacturer:'Example',series:null,model:null,visible_text:['Example'],evidence:[],confidence:{manufacturer:.8,model:0}});const r=await legacyVisionHandler(event);expect(r.statusCode).toBe(200);expect(JSON.parse(r.body)).toMatchObject({component_class:'LOCKSET',manufacturer:'Example',model:null});expect(fetchMock).toHaveBeenCalledOnce();});
 it('keeps identity unknown when the provider cannot identify the photograph',async()=>{provider({component_class:null,manufacturer:null,model:null,confidence:{manufacturer:0,model:0}});const r=await legacyVisionHandler(event);expect(r.statusCode).toBe(200);expect(JSON.parse(r.body).manufacturer).toBeNull();});
 it('does not treat an invalid response as a successful identification',async()=>{fetchMock.mockResolvedValue(new Response(JSON.stringify({content:[{text:'No JSON returned'}]}),{status:200}));expect((await legacyVisionHandler(event)).statusCode).toBe(502);});
 it.each([[401,'recognition_provider_authentication_failed'],[403,'recognition_provider_permission_denied'],[404,'recognition_provider_model_unavailable'],[429,'recognition_provider_rate_limited'],[413,'recognition_provider_image_rejected'],[400,'recognition_provider_request_rejected'],[529,'recognition_provider_temporarily_unavailable']])('classifies HTTP %i without forwarding provider details',async(status,code)=>{fetchMock.mockResolvedValue(new Response(JSON.stringify({error:{type:'error',message:'private provider detail'}}),{status:status as number}));const r=await legacyVisionHandler(event);expect(r.statusCode).toBe(502);expect(JSON.parse(r.body).error).toBe(code);expect(r.body).not.toContain('private');});
 it('distinguishes an explicit credit balance block from other invalid requests',async()=>{fetchMock.mockResolvedValue(new Response(JSON.stringify({error:{message:'Your credit balance is too low to access the Anthropic API.'}}),{status:400}));expect(JSON.parse((await legacyVisionHandler(event)).body).error).toBe('recognition_provider_billing_blocked');});
 it('classifies a timeout without exposing exception details',async()=>{fetchMock.mockRejectedValue(Object.assign(Error('private timeout detail'),{name:'TimeoutError'}));const r=await legacyVisionHandler(event);expect(JSON.parse(r.body).error).toBe('recognition_provider_timeout');expect(r.body).not.toContain('private');});
 it('classifies a network failure without exposing exception details',async()=>{fetchMock.mockRejectedValue(new TypeError('private connection detail'));const r=await legacyVisionHandler(event);expect(JSON.parse(r.body).error).toBe('recognition_provider_connection_failed');expect(r.body).not.toContain('private');});
});

it('keeps the original photograph and adds bounded detail views to identification only',async()=>{
 const sharp=(await import('sharp')).default;
 const source=await sharp({create:{width:165,height:220,channels:3,background:'grey'}}).png().toBuffer();
 provider({component_class:'DOOR_CLOSER',manufacturer:null,model:null});
 const r=await legacyVisionHandler({httpMethod:'POST',body:JSON.stringify({images:[source.toString('base64')],media_type:'image/png',mode:'identify'})});
 expect(r.statusCode).toBe(200);
 const sent=JSON.parse(fetchMock.mock.calls[0][1].body);const images=sent.messages[0].content.filter((v:any)=>v.type==='image');
 expect(images).toHaveLength(3);expect(images[0].source.data).toBe(source.toString('base64'));
 expect(sent.messages[0].content.some((v:any)=>v.type==='text'&&v.text.includes('Detail view of photograph 0'))).toBe(true);
});

it('requests geometry landmarks in the exact identification schema and retains observed arm features',async()=>{
 provider({component_class:'DOOR_CLOSER',attributes:{arm_type:'standard',mounting:'regular_arm'},evidence:[{supports:'arm_type',observation:'Two-piece articulated arm'}],installation_geometry_views:[]});
 const response=await legacyVisionHandler(event);
 const sent=JSON.parse(fetchMock.mock.calls[0][1].body);
 const exact=sent.messages[0].content.filter((c:any)=>c.type==='text').find((c:any)=>c.text.includes('in exactly this shape'));
 expect(exact.text).toContain('"installation_geometry_views"');
 expect(JSON.parse(response.body).attributes.arm_type).toBe('standard');
 expect(JSON.parse(response.body).evidence[0].observation).toBe('Two-piece articulated arm');
});

it.each([
 ['Could not decode image from base64','recognition_provider_image_format_rejected'],
 ['Image dimensions exceed maximum allowed resolution','recognition_provider_image_dimensions_rejected'],
 ['Too many tokens in request','recognition_provider_context_limit'],
 ['model is not supported','recognition_provider_model_unavailable'],
])('classifies a safe request rejection category without exposing the upstream message: %s',async(message,code)=>{
 process.env.ANTHROPIC_API_KEY='test';
 const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:message+' private-input'}}),{status:400}));
 vi.stubGlobal('fetch',fetchMock);
 try{const r=await legacyVisionHandler({httpMethod:'POST',body:JSON.stringify({images:['aW1hZ2U='],media_type:'image/png'})});expect(JSON.parse(r.body).error).toBe(code);expect(r.body).not.toContain('private-input');}finally{vi.unstubAllGlobals();}
});

it('returns only an opt-in redacted rejection reason, never credentials or quoted input',async()=>{
 const {redactProviderReason}=await import('../src/services/legacyVision');
 const secret='test-credential-only';
 const message=`messages.0.content: invalid parameter "private photo content" ${secret} sk-exampleSecret stephan@example.test ${'A'.repeat(100)}`;
 const redacted=redactProviderReason(message,secret);
 expect(redacted).toContain('invalid parameter');
 for(const value of ['private photo content',secret,'sk-exampleSecret','stephan@example.test','A'.repeat(100)])expect(redacted).not.toContain(value);
 fetchMock.mockResolvedValue(new Response(JSON.stringify({error:{message:'messages.0.content: invalid parameter'}}),{status:400}));
 const r=await legacyVisionHandler({...event,body:JSON.stringify({...JSON.parse(event.body),include_provider_diagnostic:true})});
 expect(JSON.parse(r.body).provider_diagnostic).toContain('invalid parameter');
 fetchMock.mockResolvedValue(new Response(JSON.stringify({error:{message:'messages.0.content: invalid parameter'}}),{status:400}));
 expect(JSON.parse((await legacyVisionHandler(event)).body).provider_diagnostic).toBeUndefined();
});

it('classifies the observed monthly API usage block instead of blaming the image format',async()=>{
 fetchMock.mockResolvedValue(new Response(JSON.stringify({error:{message:'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'}}),{status:400}));
 expect(JSON.parse((await legacyVisionHandler(event)).body).error).toBe('recognition_provider_usage_limit_reached');
});
it('keeps technician identity and free text out of the visual classification request',async()=>{
 provider({component_class:'DOOR_CLOSER',manufacturer:null,model:null});
 await legacyVisionHandler({...event,body:JSON.stringify({...JSON.parse(event.body),technician_attributes:{model:'private-reported-model',manufacturer:'private-reported-brand',visible_markings:'private-typed-marking',observed_features:'private-free-text'}})});
 const sent=fetchMock.mock.calls[0][1].body;
 for(const value of ['private-reported-model','private-reported-brand','private-typed-marking','private-free-text'])expect(sent).not.toContain(value);
});
it.each([{}, {component_class:'invented class'}])('rejects an invalid classifier shape %j',async value=>{provider(value);expect((await legacyVisionHandler(event)).statusCode).toBe(502);});
it('does not convert percentage confidence or object-valued fields into convincing values',async()=>{
 provider({component_class:'door closer',manufacturer:{name:'LCN'},visible_text:[{},'4040XP'],attributes:{arm_type:{value:'standard'}},confidence:{manufacturer:85}});
 const r=await legacyVisionHandler(event);expect(r.statusCode).toBe(200);const value=JSON.parse(r.body);
 expect(value.component_class).toBe('DOOR_CLOSER');expect(value.manufacturer).toBeNull();expect(value.confidence.manufacturer).toBeNull();expect(value.visible_text).toEqual(['4040XP']);expect(value.attributes).toEqual({});
});
