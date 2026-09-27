import {it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.mock('../field-app/src/lib/db',()=>({loadAuth:vi.fn(),cacheOpening:vi.fn(),getCachedOpening:vi.fn()}));
import {loadAuth,getCachedOpening} from '../field-app/src/lib/db';
import {fetchOpening} from '../field-app/src/lib/api';
beforeEach(()=>{vi.mocked(loadAuth).mockResolvedValue({token:'test',userId:'a',organizationId:'a',role:'technician',savedAt:0});vi.mocked(getCachedOpening).mockResolvedValue({id:'x'});});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it.each([401,403,404])('never displays cached data after HTTP %s',async status=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'denied'}),{status})));
 await expect(fetchOpening('x')).rejects.toMatchObject({status});expect(getCachedOpening).not.toHaveBeenCalled();
});
it('allows own cache on a network failure',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('network')));
 expect((await fetchOpening('x')).fromCache).toBe(true);
});
