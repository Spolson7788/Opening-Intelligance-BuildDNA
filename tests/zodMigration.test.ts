import {it,expect} from 'vitest';
import {z} from 'zod';
import request from 'supertest';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {withinJsonStructureLimits} from '../src/middleware/jsonStructure';

it('rejects oversized arrays before element validation and bounds arbitrary JSON collections',()=>{
 let visited=0;const schema=z.array(z.string().superRefine(()=>{visited++})).max(2);
 expect(schema.safeParse(Array(100).fill('synthetic')).success).toBe(false);expect(visited).toBe(0);
 expect(withinJsonStructureLimits({rows:Array.from({length:1000},()=>({code:'synthetic',condition:'good'}))})).toBe(true);
 expect(withinJsonStructureLimits({rows:Array(1001).fill(null)})).toBe(false);
 expect(withinJsonStructureLimits(Object.fromEntries(Array.from({length:1001},(_,i)=>['k'+i,null])))).toBe(false);
 let deep:any={};for(let i=0;i<34;i++)deep={child:deep};expect(withinJsonStructureLimits(deep)).toBe(false);
 expect(withinJsonStructureLimits(Array.from({length:1000},()=>Array(101).fill(null)))).toBe(false);
});
it('keeps the error envelope, auth gate and unknown-key handling compatible',async()=>{
 const invalid=await request(app).post('/api/auth/login').send({email:'invalid',password:123});
 expect(invalid.status).toBe(400);expect(invalid.body.error).toBe('invalid_login_request');expect(invalid.body.reference).toEqual(expect.any(String));
 expect((await request(app).post('/api/events/service-events').send({})).status).toBe(401);
 const oversized=await request(app).post('/api/events/service-events').send({parts_used:Array(1001).fill('synthetic')});
 expect(oversized.status).toBe(413);expect(oversized.body).toEqual({error:'request_structure_limit_exceeded'});
 const owner=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token),opening=await createTestOpening(owner.token,scope.buildingId),auth={Authorization:'Bearer '+owner.token};
 const component=await request(app).post('/api/hardware').set(auth).send({opening_id:opening.id,component_type:'closer',manufacturer:'Keep',condition:'good',unexpected:'ignored'});
 expect(component.status).toBe(201);expect(component.body.unexpected).toBeUndefined();
 const patch=await request(app).patch('/api/hardware/'+component.body.id).set(auth).send({expected_revision:Number(component.body.revision),model_number:'Changed'});
 expect(patch.status).toBe(200);expect(patch.body).toMatchObject({manufacturer:'Keep',condition:'good',model_number:'Changed'});
 const bad=await request(app).post('/api/events/service-events').set(auth).send({opening_id:opening.id,event_date:'2026-01-01',work_performed:'Synthetic',parts_used:[false]});
 expect(bad.status).toBe(400);expect(bad.body.error.fieldErrors.parts_used).toBeInstanceOf(Array);
 const event=await request(app).post('/api/events/service-events').set(auth).send({opening_id:opening.id,event_date:'2026-01-01',work_performed:'Synthetic',parts_used:['closer']});expect(event.status).toBe(201);
});
