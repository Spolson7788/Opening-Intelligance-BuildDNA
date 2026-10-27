import {it,expect,vi} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app';
import {createFixtureCommercialStore} from '../src/services/commercialStorage';
import {signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {pool} from '../src/db/pool';
import {getPresignedPrivatePhotoReadUrl} from '../src/services/storage';
const auth=(token:string)=>({Authorization:'Bearer '+token});
it('denies foreign and anonymous PDF reads before storage, while allowing the owner',async()=>{
 const store=createFixtureCommercialStore(),api=createApp({commercialStore:store});
 const a=await signupTestOrg('Synthetic A'),b=await signupTestOrg('Synthetic B');
 const id=randomUUID();
 expect((await request(api).post('/api/commercial/documents').set(auth(a.token)).send({id:randomUUID(),version_id:id,expected_version:0,property_id:null,title:'Synthetic private PDF',kind:'technical',pdf_base64:Buffer.from('%PDF-1.4\nSynthetic\n%%EOF').toString('base64')})).status).toBe(200);
 const read=vi.spyOn(store,'read');read.mockClear();
 const denied=await request(api).get('/api/commercial/documents/'+id).set(auth(b.token));
 expect(denied.status).toBe(404);expect(denied.body).toMatchObject({error:'not_found'});expect(denied.body.pdf_base64).toBeUndefined();expect(read).not.toHaveBeenCalled();
 expect((await request(api).get('/api/commercial/documents/'+id)).status).toBe(401);expect(read).not.toHaveBeenCalled();
 const own=await request(api).get('/api/commercial/documents/'+id).set(auth(a.token));expect(own.status).toBe(200);expect(read).toHaveBeenCalledOnce();expect(own.body.pdf_base64).toBeTruthy();
});
it('denies foreign and anonymous photo access before signing, while allowing the owner',async()=>{
 const a=await signupTestOrg('Synthetic A'),b=await signupTestOrg('Synthetic B'),scope=await createPortfolioHierarchy(a.token),opening=await createTestOpening(a.token,scope.buildingId);
 const photo=await pool.query("INSERT INTO photos(opening_id,storage_url,storage_object_key) VALUES($1,'synthetic-local','synthetic/local/photo.png') RETURNING id",[opening.id]);
 const api=createApp(),sign=vi.mocked(getPresignedPrivatePhotoReadUrl);sign.mockClear();
 const path='/api/photos/'+photo.rows[0].id+'/access';
 const denied=await request(api).get(path).set(auth(b.token));expect(denied.status).toBe(404);expect(denied.body).toEqual({error:'not_found'});expect(sign).not.toHaveBeenCalled();
 expect((await request(api).get(path)).status).toBe(401);expect(sign).not.toHaveBeenCalled();
 expect((await request(api).get(path).set(auth(a.token))).status).toBe(200);expect(sign).toHaveBeenCalledOnce();
});
