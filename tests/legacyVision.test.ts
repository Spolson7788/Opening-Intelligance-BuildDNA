import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {legacyVisionHandler} from '../src/services/legacyVision';
const fetchMock=vi.fn();
const event={httpMethod:'POST',body:JSON.stringify({images:['/9j/AA=='],media_type:'image/jpeg',mode:'identify'})};
beforeEach(()=>{vi.stubEnv('ANTHROPIC_API_KEY','test-not-real');vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function provider(result:unknown){fetchMock.mockResolvedValue(new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify(result)}]}),{status:200}));}
describe('real recognition engine response handling',()=>{
 it('returns an ordinary identification instead of crashing after a successful provider response',async()=>{provider({component_class:'LOCKSET',manufacturer:'Example',series:null,model:null,visible_text:['Example'],evidence:[],confidence:{manufacturer:.8,model:0}});const r=await legacyVisionHandler(event);expect(r.statusCode).toBe(200);expect(JSON.parse(r.body)).toMatchObject({component_class:'LOCKSET',manufacturer:'Example',model:null});expect(fetchMock).toHaveBeenCalledOnce();});
 it('keeps identity unknown when the provider cannot identify the photograph',async()=>{provider({manufacturer:null,model:null,confidence:{manufacturer:0,model:0}});const r=await legacyVisionHandler(event);expect(r.statusCode).toBe(200);expect(JSON.parse(r.body).manufacturer).toBeNull();});
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
