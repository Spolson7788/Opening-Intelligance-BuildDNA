import {it,expect,vi,beforeEach} from 'vitest';
import {createHash} from 'node:crypto';
const mock=vi.hoisted(()=>({send:vi.fn(),query:vi.fn()}));
vi.mock('../src/db/pool',()=>({pool:{query:mock.query}}));
vi.mock('@aws-sdk/client-s3',()=>{class Command{constructor(public input:any){}}return {S3Client:class{send=mock.send;},GetObjectCommand:Command,PutObjectCommand:Command,DeleteObjectCommand:Command,HeadObjectCommand:Command,CopyObjectCommand:Command};});
import {orderedRecognitionPhotos,loadRecognitionOriginals} from '../src/services/recognitionOriginals';
import {readPrivatePhotoBytes,buildPrivatePhotoStorageKey,maximumMediaBytes} from '../src/services/storage';
import {stabilityRuntime} from '../src/services/recognitionStabilityBudget';
const scope={openingId:'opening',organizationId:'org',userId:'actor'};
const photo=(id:string,bytes=3*1024*1024)=>({id,opening_id:scope.openingId,organization_id:scope.organizationId,uploaded_by_user_id:scope.userId,upload_state:'verified',storage_verified_at:'date',authorized_retrieval_verified_at:'date',content_type:'image/jpeg',byte_size:bytes,sha256_checksum:'a'.repeat(64),storage_object_key:buildPrivatePhotoStorageKey('org','opening',id,'image/jpeg')});
beforeEach(()=>{mock.send.mockReset();mock.query.mockReset();for(const key of ['S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])vi.stubEnv(key,'test-only');});
it('preserves input order and admits verified originals larger than the old combined limit',()=>{
 expect(orderedRecognitionPhotos(['b','a'],[photo('a'),photo('b')],scope,'image/jpeg').map(r=>r.id)).toEqual(['b','a']);
});
it('rejects foreign opening, organization, actor, missing verification and forged storage paths',()=>{
 for(const change of [{opening_id:'other'},{organization_id:'other'},{uploaded_by_user_id:'other'},{upload_state:'pending'},{authorized_retrieval_verified_at:null},{storage_object_key:'private/org/other/photo/a.jpg'},{content_type:'image/png'}]){
  expect(()=>orderedRecognitionPhotos(['a'],[{...photo('a'),...change}],scope,'image/jpeg')).toThrow();
 }
 expect(()=>orderedRecognitionPhotos(['a','a'],[photo('a'),photo('a')],scope,'image/jpeg')).toThrow();
});
it('rejects per-photo and total bounds before storage retrieval',()=>{
 expect(()=>orderedRecognitionPhotos(['a'],[photo('a',13*1024*1024)],scope,'image/jpeg')).toThrow('too_large');
 expect(()=>orderedRecognitionPhotos(['a','b','c','d'],['a','b','c','d'].map(id=>photo(id,12*1024*1024)),scope,'image/jpeg')).toThrow('too_large');
});
it('reads native bytes and rejects a mutated object even when its recorded metadata was verified',async()=>{
 const bytes=Buffer.alloc(3*1024*1024,7),sha=createHash('sha256').update(bytes).digest('hex');
 async function* body(){yield bytes;}
 mock.send.mockImplementation(async()=>({ContentLength:bytes.length,Body:body()}));
 const result=await readPrivatePhotoBytes('key',bytes.length,sha,AbortSignal.timeout(1000));expect(Buffer.compare(result,bytes)).toBe(0);
 await expect(readPrivatePhotoBytes('key',bytes.length,'b'.repeat(64),AbortSignal.timeout(1000))).rejects.toThrow('checksum');
 mock.send.mockResolvedValue({ContentLength:bytes.length+1,Body:body()});
 await expect(readPrivatePhotoBytes('key',bytes.length,sha,AbortSignal.timeout(1000))).rejects.toThrow('size');
});
it('scopes the database lookup before object reads and preserves source hashes',async()=>{
 const bytes=Buffer.from('native original'),row={...photo('a',bytes.length),sha256_checksum:createHash('sha256').update(bytes).digest('hex')};
 mock.query.mockResolvedValue({rows:[row]});
 mock.send.mockResolvedValue({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()});
 const result=await loadRecognitionOriginals(['a'],scope,'image/jpeg');
 expect(mock.query.mock.calls[0][1]).toEqual([['a'],'opening','org','actor']);expect(result.sources[0].sha256).toBe(row.sha256_checksum);
 expect(result.images[0]).toEqual(bytes);
});
it('keeps ordinary and production image limits at 2 MB; only guarded previews admit originals',()=>{
 vi.stubEnv('OI_STABILITY_TRIAL_REQUIRED','true');vi.stubEnv('OI_STABILITY_TRIAL_ID','80a29645-c81a-4bad-9a2e-16afaa188d03');
 expect(stabilityRuntime.run('production',()=>maximumMediaBytes('image/jpeg'))).toBe(2*1024*1024);
 expect(stabilityRuntime.run('deploy-preview',()=>maximumMediaBytes('image/jpeg'))).toBe(12*1024*1024);
});
