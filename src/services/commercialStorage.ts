import {createHash} from 'node:crypto';
// Trusted server adapter, never populated from request metadata. Production has
// no default: private immutable retention must be verified by its integration.
export interface CommercialStore {
  readonly privateImmutable: true;
  readonly mode: 'fixture' | 'verified';
  putOnce(key:string, bytes:Buffer):Promise<void>;
  read(key:string):Promise<Buffer>;
}
export const documentHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function verifiedDocument(c:any,id:string,store:CommercialStore|undefined){
 const row=(await c.query('SELECT v.*,d.organization_id,d.property_id,d.kind,d.title FROM commercial_document_versions v JOIN commercial_documents d ON d.id=v.document_id WHERE v.id=$1',[id])).rows[0];
 if(!row||!store?.privateImmutable)throw new Error('verified_private_document_required');
 let bytes:Buffer;try{bytes=await store.read(row.object_key);}catch{throw new Error('document_object_unavailable');}
 if(bytes.length!==Number(row.byte_size)||documentHash(bytes)!==row.sha256)throw new Error('document_integrity_failed');
 return {...row,bytes};
}
// Explicit disposable fixture adapter. Not wired into production createApp().
export function createFixtureCommercialStore():CommercialStore {
 const objects=new Map<string,Buffer>();return {privateImmutable:true,mode:'fixture',
 async putOnce(key,bytes){if(objects.has(key)){if(!objects.get(key)!.equals(bytes))throw Error('immutable_object_exists');return;}objects.set(key,Buffer.from(bytes));},
 async read(key){const bytes=objects.get(key);if(!bytes)throw Error('object_missing');return Buffer.from(bytes);}};
}
