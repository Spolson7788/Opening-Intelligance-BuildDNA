import {it,expect,vi,afterEach} from 'vitest';
import jwt from 'jsonwebtoken';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn()}}));
import {pool} from '../src/db/pool';
import {requireAuth} from '../src/middleware/auth';
afterEach(()=>vi.resetAllMocks());
async function invoke(token:string){
 const req:any={headers:{authorization:`Bearer ${token}`}};
 const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis()};
 const next=vi.fn();await requireAuth(req,res,next);return {req,res,next};
}
const token=()=>jwt.sign({userId:'u',organizationId:'o',role:'admin'},process.env.JWT_SECRET!);
it('denies unavailable current-authority lookup with 503, never calling the route',async()=>{
 vi.mocked(pool.query).mockRejectedValueOnce(new Error('database unreachable'));
 const r=await invoke(token());expect(r.res.status).toHaveBeenCalledWith(503);expect(r.res.json).toHaveBeenCalledWith({error:'authorization_service_unavailable'});expect(r.next).not.toHaveBeenCalled();
});
it('rejects invalid signatures before querying current authority',async()=>{
 const r=await invoke('invalid');expect(r.res.status).toHaveBeenCalledWith(401);expect(pool.query).not.toHaveBeenCalled();expect(r.next).not.toHaveBeenCalled();
});
it('still rejects deactivated accounts',async()=>{
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{id:'u',organization_id:'o',is_active:false,role:'admin'}]} as never);
 const r=await invoke(token());expect(r.res.status).toHaveBeenCalledWith(403);expect(r.next).not.toHaveBeenCalled();
});
it('uses current role instead of stale token role after recovery',async()=>{
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{id:'u',organization_id:'o',is_active:true,role:'technician'}]} as never);
 const r=await invoke(token());expect(r.req.auth.role).toBe('technician');expect(r.next).toHaveBeenCalledOnce();
});
it('rejects an old session after password recovery',async()=>{
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{id:'u',organization_id:'o',is_active:true,role:'technician',session_version:1}]} as never);
 const r=await invoke(token());expect(r.res.status).toHaveBeenCalledWith(401);expect(r.res.json).toHaveBeenCalledWith({error:'session_revoked'});expect(r.next).not.toHaveBeenCalled();
});
it('accepts the new session version after recovery',async()=>{
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{id:'u',organization_id:'o',is_active:true,role:'technician',session_version:1}]} as never);
 const r=await invoke(jwt.sign({userId:'u',organizationId:'o',role:'technician',sessionVersion:1},process.env.JWT_SECRET!));expect(r.next).toHaveBeenCalledOnce();
});
