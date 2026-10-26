import {it,expect,vi} from 'vitest';
import {createSupabaseCommercialStore,COMMERCIAL_PDF_MAX_BYTES} from '../src/services/supabaseCommercialStorage';
const key='01234567-89ab-4cde-8fab-0123456789ab',bucket='oi-video-workflows-media',bytes=Buffer.from('%PDF-1.4\nSynthetic local fixture only');
const config={enabled:true as const,apiKey:'synthetic-private-api-key',getAccessToken:async()=>'synthetic-private-bearer'};
const bucketResponse=(isPublic=false)=>new Response(JSON.stringify({id:bucket,public:isPublic}),{headers:{'content-type':'application/json'}});
const objectResponse=(body:Buffer=bytes)=>new Response(new Uint8Array(body),{headers:{'content-type':'application/pdf','content-length':String(body.length)}});
function server(){const objects=new Map<string,Buffer>();const transport=vi.fn(async(path:string,init:RequestInit)=>{if(path.includes('/bucket/'))return bucketResponse();if(init.method==='POST'){if(objects.has(path))return new Response('Asset Already Exists',{status:400});objects.set(path,Buffer.from(init.body as Uint8Array));return new Response('{}',{status:200});}const data=objects.get(path);return data?objectResponse(data):new Response('not found',{status:404});});return {objects,transport};}
it('is explicitly configured and verifies a private bucket before declaring availability',async()=>{
 const f=vi.fn();await expect(createSupabaseCommercialStore({...config,enabled:false} as any,f)).rejects.toThrow('commercial_storage_not_configured');expect(f).not.toHaveBeenCalled();
 await expect(createSupabaseCommercialStore(config,async()=>bucketResponse(true))).rejects.toThrow('commercial_private_bucket_required');
 await expect(createSupabaseCommercialStore(config,async()=>new Response(JSON.stringify({id:'other',public:false})))).rejects.toThrow('commercial_private_bucket_required');
});
it('uses fixed private REST create-only namespace and verifies read-back bytes',async()=>{
 const s=server(),store=await createSupabaseCommercialStore(config,s.transport);await store.putOnce(key,bytes);expect(await store.read(key)).toEqual(bytes);
 const posts=s.transport.mock.calls.filter(([,init])=>init.method==='POST');expect(posts).toHaveLength(1);const [url,init]=posts[0];expect(url).toBe(`https://boaoedvyvifppuklbwad.supabase.co/storage/v1/object/${bucket}/commercial-documents/v1/${key}.pdf`);expect(init.headers).toMatchObject({'x-upsert':'false','Content-Type':'application/pdf'});
 for(const [url,init] of s.transport.mock.calls){expect(init.redirect).toBe('error');expect(init.cache).toBe('no-store');expect(url).not.toContain('/public/');expect(['GET','POST']).toContain(init.method);}
});
it('identical retries verify existing bytes without overwriting; changed bytes reject',async()=>{
 const s=server(),store=await createSupabaseCommercialStore(config,s.transport);await store.putOnce(key,bytes);await store.putOnce(key,Buffer.from(bytes));await expect(store.putOnce(key,Buffer.from('%PDF-other'))).rejects.toThrow('immutable_object_exists');expect([...s.objects.values()][0]).toEqual(bytes);
});
it('concurrent different payloads create one immutable object',async()=>{
 const s=server(),store=await createSupabaseCommercialStore(config,s.transport);const result=await Promise.allSettled([store.putOnce(key,bytes),store.putOnce(key,Buffer.from('%PDF-other'))]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(s.objects.size).toBe(1);expect([...s.objects.values()][0]).toEqual(bytes);
});
it('reconciles response loss after creation with one read and no repeated POST',async()=>{
 const s=server();const transport=vi.fn(async(path:string,init:RequestInit)=>{const response=await s.transport(path,init);if(init.method==='POST')throw Error('Sensitive provider detail');return response;});const store=await createSupabaseCommercialStore(config,transport);await store.putOnce(key,bytes);expect(transport.mock.calls.filter(([,i])=>i.method==='POST')).toHaveLength(1);
});
it('reports uncertain create without exposing provider text and never retries/deletes',async()=>{
 const transport=vi.fn(async(path:string,init:RequestInit)=>path.includes('/bucket/')?bucketResponse():init.method==='POST'?Promise.reject(Error('synthetic-secret-private-url')):new Response('private-provider-text',{status:404}));const store=await createSupabaseCommercialStore(config,transport);await expect(store.putOnce(key,bytes)).rejects.toThrow(/^commercial_object_create_unconfirmed$/);expect(transport.mock.calls.filter(([,i])=>i.method==='POST')).toHaveLength(1);
});
it('refuses path injection and invalid or oversized PDFs before object requests',async()=>{
 const s=server(),store=await createSupabaseCommercialStore(config,s.transport);for(const bad of ['../photo','https://other.invalid/a',key+'/../b',key+'?x=1'])await expect(store.putOnce(bad,bytes)).rejects.toThrow('commercial_object_key_invalid');await expect(store.putOnce(key,Buffer.from('not a PDF'))).rejects.toThrow('commercial_pdf_invalid');await expect(store.putOnce(key,Buffer.alloc(COMMERCIAL_PDF_MAX_BYTES+1))).rejects.toThrow('commercial_pdf_invalid');expect(s.transport).toHaveBeenCalledTimes(1);
});
it('refuses missing, non-PDF or oversized objects and limits streamed bytes',async()=>{
 let mode='missing',cancelled=false;
 const transport=async(path:string)=>{if(path.includes('/bucket/'))return bucketResponse();if(mode==='missing')return new Response('missing',{status:404});if(mode==='mime')return new Response(bytes.toString(),{headers:{'content-type':'text/plain'}});if(mode==='length')return new Response('',{headers:{'content-type':'application/pdf','content-length':String(COMMERCIAL_PDF_MAX_BYTES+1)}});return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(COMMERCIAL_PDF_MAX_BYTES+1));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf'}});};
 const store=await createSupabaseCommercialStore(config,transport);for(mode of ['missing','mime','length','stream'])await expect(store.read(key)).rejects.toThrow('commercial_object_unavailable');expect(cancelled).toBe(true);
});
it('rechecks privacy before every operation and performs no write after privacy changes',async()=>{
 const s=server();let publicNow=false;const store=await createSupabaseCommercialStore(config,async(p,i)=>p.includes('/bucket/')?bucketResponse(publicNow):s.transport(p,i));publicNow=true;await expect(store.putOnce(key,bytes)).rejects.toThrow('commercial_private_bucket_required');await expect(store.read(key)).rejects.toThrow('commercial_private_bucket_required');expect(s.transport).not.toHaveBeenCalled();
});
it('stops on authorization failures without a fallback read or exposing response text',async()=>{
 const transport=vi.fn(async(path:string)=>path.includes('/bucket/')?bucketResponse():new Response('private auth detail',{status:403}));const store=await createSupabaseCommercialStore(config,transport);await expect(store.putOnce(key,bytes)).rejects.toThrow(/^commercial_object_create_failed$/);expect(transport.mock.calls).toHaveLength(3);
});
it('does not expose borrowed buffer mutations while waiting for storage',async()=>{
 const s=server();let release!:()=>void,count=0;const store=await createSupabaseCommercialStore(config,async(p,i)=>{if(p.includes('/bucket/')&&++count===2)await new Promise<void>(r=>release=r);return s.transport(p,i);});const input=Buffer.from(bytes),writing=store.putOnce(key,input);input.fill(0);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));release();await writing;expect([...s.objects.values()][0]).toEqual(bytes);
});
