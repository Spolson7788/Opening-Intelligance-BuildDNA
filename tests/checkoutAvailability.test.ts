import express from 'express';
import request from 'supertest';
import {beforeEach,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn()}));
vi.mock('../src/db/pool',()=>({pool:db}));
vi.mock('../src/middleware/auth',()=>({requireAuth:(req:any,_res:any,next:any)=>{req.auth={userId:'u',organizationId:'o',role:'admin'};next();},requireRole:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../src/middleware/auditLog',()=>({auditLog:(_req:any,_res:any,next:any)=>next()}));
import {commercialRouter} from '../src/routes/commercial';
import {sandboxFinanceRouter} from '../src/routes/sandboxFinance';
import {photosRouter} from '../src/routes/photos';
import {syncRouter} from '../src/routes/sync';
import {hardwareRouter} from '../src/routes/hardware';
import {openingsRouter} from '../src/routes/openings';
import {portfolioRouter} from '../src/routes/portfolio';
import {workOrdersRouter} from '../src/routes/workOrders';
import {maintenanceSchedulesRouter} from '../src/routes/maintenanceSchedulesRoute';
import {acquireClient} from '../src/db/acquireClient';
const id='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{vi.resetAllMocks();db.connect.mockRejectedValue(new Error('private connection detail'));db.query.mockRejectedValue(new Error('private query detail'));});
function app(){const a=express();a.use(express.json());a.use('/commercial',commercialRouter);a.use('/finance',sandboxFinanceRouter);a.use('/photos',photosRouter);a.use('/sync',syncRouter);a.use('/hardware',hardwareRouter);a.use('/openings',openingsRouter);a.use('/portfolio',portfolioRouter);a.use('/work-orders',workOrdersRouter);a.use('/maintenance',maintenanceSchedulesRouter);return a;}
it.each(['/commercial/documents/'+id,'/finance/'+id])('returns sanitized unavailable for %s without running queries',async path=>{
 const r=await request(app()).get(path);expect(r.status).toBe(503);expect(r.body).toEqual({error:'database_unavailable'});expect(r.headers['cache-control']).toBe('no-store');expect(db.connect).toHaveBeenCalledTimes(1);expect(db.query).not.toHaveBeenCalled();
});
it.each([
 ['get','/photos/'+id+'/access',{}],
 ['put','/openings/'+id+'/frame',{}],
 ['post','/openings/'+id+'/door-leaves',{leaf_role:'active'}],
 ['post','/openings/'+id+'/complete',{}],
 ['get','/portfolio/compliance-alerts?property_id='+id,{}],
 ['get','/portfolio/warranty-alerts?property_id='+id,{}],
 ['get','/work-orders/'+id,{}],
 ['patch','/work-orders/'+id,{title:'Synthetic'}],
 ['post','/work-orders/'+id+'/status',{status:'done'}],
 ['patch','/maintenance/'+id,{title:'Synthetic'}],
] as const)('contains rejected implicit checkout in %s %s',async(method,path,body)=>{
 const r=await request(app())[method](path).send(body);
 expect(r.status).toBe(503);expect(r.body).toEqual({error:'database_unavailable'});
 expect(db.query).toHaveBeenCalledTimes(1);expect(db.connect).not.toHaveBeenCalled();
});
it('preserves normal not-found and successful detail responses without retry',async()=>{
 db.query.mockResolvedValueOnce({rows:[]});let r=await request(app()).get('/work-orders/'+id);expect(r.status).toBe(404);
 db.query.mockResolvedValueOnce({rows:[{id,title:'Synthetic'}]});r=await request(app()).get('/work-orders/'+id);expect(r.status).toBe(200);expect(r.body.id).toBe(id);expect(db.query).toHaveBeenCalledTimes(2);
});
it('does not confirm or access storage after a photo checkout failure',async()=>{
 const r=await request(app()).post('/photos/offline/confirm').send({photo_id:id,client_operation_id:id,schema_version:3,app_version:'test',protocol_version:1});expect(r.status).toBe(503);expect(r.body).toEqual({error:'database_unavailable'});expect(db.connect).toHaveBeenCalledTimes(1);expect(db.query).not.toHaveBeenCalled();
});
it('does not execute or retry a queued component mutation after checkout failure',async()=>{
 const r=await request(app()).post('/sync/components').send({operation_id:id,entity_id:id,opening_id:id,device_id:id,base_server_revision:null,schema_version:3,app_version:'test',protocol_version:1,payload:{component_type:'closer'}});expect(r.status).toBe(503);expect(r.body).toEqual({error:'database_unavailable'});expect(db.connect).toHaveBeenCalledTimes(1);expect(db.query).not.toHaveBeenCalled();
});
it('returns an acquired client unchanged and leaves release to the transaction owner',async()=>{
 const c={query:vi.fn(),release:vi.fn()};db.connect.mockResolvedValueOnce(c);const res:any={set:vi.fn(),status:vi.fn(),json:vi.fn()};expect(await acquireClient(res)).toBe(c);expect(c.release).not.toHaveBeenCalled();expect(res.status).not.toHaveBeenCalled();
});
it('preserves committed bulk rows and marks remaining rows unattempted after checkout fails',async()=>{
 const query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('SELECT id FROM openings WHERE opening_code'))return {rows:[{id}],rowCount:1};
  if(sql.startsWith('SELECT id FROM openings WHERE id='))return {rows:[{id}],rowCount:1};
  if(sql.includes('INSERT INTO hardware_components'))return {rows:[{id}],rowCount:1};
  return {rows:[],rowCount:0};
 });const release=vi.fn();db.connect.mockResolvedValueOnce({query,release});
 const r=await request(app()).post('/hardware/bulk-import').send({rows:[1,2,3].map(n=>({opening_code:'SYN-'+n,component_type:'closer'}))});
 expect(r.status).toBe(207);expect(r.body.created).toBe(1);expect(r.body.failed).toBe(2);
 expect(r.body.results.slice(1).map((x:any)=>x.error)).toEqual(['database_unavailable_not_attempted','database_unavailable_not_attempted']);
 expect(query.mock.calls.filter(([sql])=>sql==='COMMIT')).toHaveLength(1);expect(db.connect).toHaveBeenCalledTimes(2);expect(release).toHaveBeenCalledOnce();
});
