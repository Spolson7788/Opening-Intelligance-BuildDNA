import {it,expect,vi,beforeEach} from 'vitest';
import {createHash} from 'node:crypto';
const mock=vi.hoisted(()=>({send:vi.fn(),query:vi.fn()}));
vi.mock('../src/db/pool',()=>({pool:{query:mock.query}}));
vi.mock('@aws-sdk/client-s3',()=>{class Command{constructor(public input:any){}}return {S3Client:class{send=mock.send;},GetObjectCommand:Command,PutObjectCommand:Command,DeleteObjectCommand:Command,HeadObjectCommand:Command,CopyObjectCommand:Command};});
import {orderedRecognitionPhotos,loadRecognitionOriginals,prepareRecognitionOriginals,originalPreparationReason} from '../src/services/recognitionOriginals';
import sharp from 'sharp';
import {recognitionInputPixelLimit} from '../src/services/recognitionOriginalLimits';
import {cropLabel,labelCropBox} from '../src/services/labelReading';
import {prepareProviderImage} from '../src/services/recognitionImage';
import {readPrivatePhotoBytes,buildPrivatePhotoStorageKey,maximumMediaBytes} from '../src/services/storage';
import {stabilityRuntime} from '../src/services/recognitionStabilityBudget';
const scope={openingId:'opening',organizationId:'org',userId:'actor'};
const photo=(id:string,bytes=3*1024*1024)=>({id,opening_id:scope.openingId,organization_id:scope.organizationId,uploaded_by_user_id:scope.userId,upload_state:'verified',storage_verified_at:'date',authorized_retrieval_verified_at:'date',content_type:'image/jpeg',byte_size:bytes,sha256_checksum:'a'.repeat(64),storage_object_key:buildPrivatePhotoStorageKey('org','opening',id,'image/jpeg')});
beforeEach(()=>{mock.send.mockReset();mock.query.mockReset();vi.stubEnv('OI_STABILITY_TRIAL_REQUIRED','false');for(const key of ['S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])vi.stubEnv(key,'test-only');});
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
 expect(stabilityRuntime.run('production',()=>recognitionInputPixelLimit())).toBe(16_000_000);
 expect(stabilityRuntime.run('deploy-preview',()=>recognitionInputPixelLimit())).toBe(64_000_000);
});
it('accepts a native 48MP guarded original through normalization, native crop and provider preparation',async()=>{
 vi.stubEnv('OI_STABILITY_TRIAL_REQUIRED','true');vi.stubEnv('OI_STABILITY_TRIAL_ID','80a29645-c81a-4bad-9a2e-16afaa188d03');
 const bytes=await sharp({create:{width:8064,height:6048,channels:3,background:'#ddd'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const hash=createHash('sha256').update(bytes).digest('hex');
 mock.query.mockResolvedValue({rows:[{...photo('a',bytes.length),sha256_checksum:hash}]});
 mock.send.mockResolvedValue({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()});
 await stabilityRuntime.run('deploy-preview',async()=>{
  const prepared=await prepareRecognitionOriginals(['a'],scope,'image/jpeg');
  expect(prepared.hashes).toEqual([hash]);
  const native=await sharp(prepared.images[0]).metadata();expect([native.width,native.height]).toEqual([6048,8064]);
  const region={photo_index:0,x:.1,y:.1,w:.35,h:.12,rotation:0};
  const crop=await cropLabel(prepared.images[0],region);
  const box=labelCropBox({width:6048,height:8064},region);
  const actual=await sharp(crop).raw().toBuffer();
  const expected=await sharp(prepared.images[0]).extract(box).raw().toBuffer();expect(Buffer.compare(actual,expected)).toBe(0);
  const provider=await prepareProviderImage(prepared.images[0]);expect(provider.metadata.bytes).toBeLessThanOrEqual(1_000_000);expect(Math.max(provider.metadata.width,provider.metadata.height)).toBeLessThanOrEqual(1568);
 });
},20000);
it('rejects a set above 160MP before any normalization and exposes only header dimensions',async()=>{
 vi.stubEnv('OI_STABILITY_TRIAL_REQUIRED','true');vi.stubEnv('OI_STABILITY_TRIAL_ID','80a29645-c81a-4bad-9a2e-16afaa188d03');
 const bytes=await sharp({create:{width:8000,height:8000,channels:3,background:'#ddd'}}).jpeg().toBuffer();
 const hash=createHash('sha256').update(bytes).digest('hex');
 mock.query.mockResolvedValue({rows:['a','b','c'].map(id=>({...photo(id,bytes.length),sha256_checksum:hash}))});
 mock.send.mockImplementation(async()=>({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()}));
 const stages:string[]=[];
 await stabilityRuntime.run('deploy-preview',async()=>{
  try{await prepareRecognitionOriginals(['a','b','c'],scope,'image/jpeg',s=>stages.push(s));throw Error('Expected rejection');}
  catch(e){expect(originalPreparationReason(e)).toBe('recognition_source_pixel_limit');expect((e as any).dimensions).toHaveLength(3);}
 });
 expect(stages).toEqual(['original_retrieval','original_metadata']);
},20000);
it('prepares native 12MP storage bytes upright without changing their recorded original hash',async()=>{
 const bytes=await sharp({create:{width:4032,height:3024,channels:3,background:'#ddd'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const hash=createHash('sha256').update(bytes).digest('hex');
 mock.query.mockResolvedValue({rows:[{...photo('a',bytes.length),sha256_checksum:hash}]});
 mock.send.mockResolvedValue({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()});
 const stages:string[]=[];
 const result=await prepareRecognitionOriginals(['a'],scope,'image/jpeg',s=>stages.push(s));
 expect(result.hashes).toEqual([hash]);expect(stages).toEqual(['original_retrieval','original_metadata','image_normalization']);
 const metadata=await sharp(result.images[0]).metadata();expect([metadata.width,metadata.height]).toEqual([3024,4032]);
},10000);
it('isolates dimension failure from access failure without leaking exception details',async()=>{
 const bytes=await sharp({create:{width:4100,height:4100,channels:3,background:'#ddd'}}).jpeg().toBuffer();
 mock.query.mockResolvedValue({rows:[{...photo('a',bytes.length),sha256_checksum:createHash('sha256').update(bytes).digest('hex')}]});
 mock.send.mockResolvedValue({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()});
 const stages:string[]=[];
 try{await prepareRecognitionOriginals(['a'],scope,'image/jpeg',s=>stages.push(s));throw Error('Expected rejection');}
 catch(e){expect(originalPreparationReason(e)).toBe('recognition_source_pixel_limit');}
 expect(stages).toEqual(['original_retrieval','original_metadata']);
 expect(originalPreparationReason(Error('credential-bearing database exception'))).toBe('source_preparation_failed');
},10000);
it('reports a storage timeout at retrieval before normalization',async()=>{
 mock.query.mockResolvedValue({rows:[photo('a')]});mock.send.mockRejectedValue(Object.assign(Error('not exposed'),{name:'AbortError'}));
 const stages:string[]=[];
 try{await prepareRecognitionOriginals(['a'],scope,'image/jpeg',s=>stages.push(s));throw Error('Expected rejection');}
 catch(e){expect(originalPreparationReason(e)).toBe('source_timeout');}
 expect(stages).toEqual(['original_retrieval']);
});
