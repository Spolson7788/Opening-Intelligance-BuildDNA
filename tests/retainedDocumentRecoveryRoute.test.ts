import {it,expect,vi,beforeEach} from 'vitest';
import express from 'express';
import request from 'supertest';
const state=vi.hoisted(()=>({auth:null as any,query:vi.fn(async()=>({rows:[]}))}));
vi.mock('../src/middleware/auth',()=>({requireAuth:(req:any,res:any,next:any)=>{if(!state.auth)return res.status(401).json({error:'missing_token'});req.auth=state.auth;next();}}));
vi.mock('../src/db/pool',()=>({pool:{connect:async()=>({query:state.query,release:()=>{}})}}));
import {commercialRouter} from '../src/routes/commercial';
import {RETAINED_DOCUMENT as p} from '../src/services/retainedDocumentRecovery';
beforeEach(()=>{state.auth={userId:p.actor,organizationId:p.org,role:'admin'};state.query.mockClear();});
function app(allowed=true,enabled=true,isolated=true){const a=express();a.use(express.json());Object.assign(a.locals,{commercialInputsOnly:isolated,commercialInputsEnabled:enabled,retainedDocumentRecoveryAllowed:()=>allowed,commercialStore:{privateImmutable:true,read:()=>{throw Error('not expected');}}});a.use('/api/commercial',commercialRouter);return a;}
const path='/api/commercial/documents/recover-retained-staging';
it('requires authenticated session before recovery route',async()=>{state.auth=null;expect((await request(app()).post(path).send({})).status).toBe(401);expect(state.query).not.toHaveBeenCalled();});
it('rejects wrong actor, tenant, role and hidden activation',async()=>{
 for(const a of [{...state.auth,userId:'other'},{...state.auth,organizationId:'other'},{...state.auth,role:'facilities_manager'}]){state.auth=a;expect((await request(app()).post(path).send({})).status).toBe(404);}
 state.auth={userId:p.actor,organizationId:p.org,role:'admin'};
 expect((await request(app(false)).post(path).send({})).status).toBe(404);
 expect((await request(app(true,false)).post(path).send({})).status).toBe(503);
 expect((await request(app(true,true,false)).post(path).send({})).status).toBe(404);
});
it('rejects arbitrary object, actor, metadata or PDF in body before storage access',async()=>{for(const b of [{object_key:'other'},{actor:p.actor},{title:'invented'},{pdf_base64:'anything'}])expect((await request(app()).post(path).send(b)).status).toBe(422);});
