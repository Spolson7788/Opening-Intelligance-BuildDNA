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
});
