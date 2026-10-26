import {documentHash, type CommercialStore} from './commercialStorage';
import {canonicalPayloadHash} from './syncProtocol';

// One known synthetic orphan, not an arbitrary object-adoption facility.
export const RETAINED_DOCUMENT = Object.freeze({
 site:'b64bf33c-a131-4ae2-b2b0-9aec16e9f77b',
 project:'boaoedvyvifppuklbwad',
 actor:'5f78bc78-c2a3-4cf4-bec3-9d4addae78be',
 org:'66c07d0e-887d-4b78-a6bc-181b2a644c34',
 version:'ca665af9-a08b-423d-97ef-a90ecdee95f5',
 // New recovery series identity; explicitly NOT the lost original series ID.
 series:'ca665af9-a08b-423d-97ef-a90ecdee95f5',
 title:'Recovered synthetic closer evidence - original submission metadata unavailable',
 kind:'technical', bytes:664,
 sha256:'95c299eb61a9ac6c417e5b14ef54479f03c9666d7bee77fd80e9d57b90daef00',
});
export function retainedRecoveryWindow(context:{site?:{id?:string};deploy?:{context?:string}}|undefined,env:Record<string,string|undefined>,now=Date.now()){
 const start=Date.parse(env.OI_RETAINED_DOCUMENT_START||''),end=Date.parse(env.OI_RETAINED_DOCUMENT_END||'');
 return context?.site?.id===RETAINED_DOCUMENT.site&&context?.deploy?.context==='production'&&env.OI_RETAINED_DOCUMENT_ENABLED==='true'&&Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=900000&&now>=start&&now<end;
}
export function retainedRecoveryActor(auth:{userId:string;organizationId:string;role:string}|undefined){
 return auth?.userId===RETAINED_DOCUMENT.actor&&auth.organizationId===RETAINED_DOCUMENT.org&&auth.role==='admin';
}
export class RetainedRecoveryError extends Error {}
// Caller owns BEGIN/COMMIT/ROLLBACK and current-session authorization. No storage write API is used.
export async function recoverRetainedDocument(c:{query:(s:string,a?:any[])=>Promise<any>},store:CommercialStore,allowed:()=>boolean){
 const p=RETAINED_DOCUMENT,deny=()=>{throw new RetainedRecoveryError('retained_document_recovery_unavailable');};
 if(!allowed()||store?.privateImmutable!==true)deny();
 // Serializes this exact recovery, including lost-response retries across Function instances.
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['retained-document:'+p.version]);
 if(!allowed())deny();
 let bytes:Buffer;try{bytes=await store.read(p.version);}catch{throw new RetainedRecoveryError('retained_document_read_unavailable');}
 if(bytes.length!==p.bytes||bytes.subarray(0,5).toString('ascii')!=='%PDF-'||documentHash(bytes)!==p.sha256)throw new RetainedRecoveryError('retained_document_integrity_failed');
 const hash=canonicalPayloadHash({recovery:'synthetic-orphan-v1',series:p.series,version:p.version,title:p.title,kind:p.kind,org:p.org,actor:p.actor,sha256:p.sha256,bytes:p.bytes});
 const old=(await c.query('SELECT * FROM commercial_document_versions WHERE id=$1::uuid OR object_key=$1::text',[p.version])).rows;
 const docs=(await c.query('SELECT * FROM commercial_documents WHERE id=$1 FOR UPDATE',[p.series])).rows;
 if(old.length||docs.length){
  const v=old[0],d=docs[0];
  if(old.length!==1||docs.length!==1||v.id!==p.version||v.object_key!==p.version||v.document_id!==p.series||v.request_hash!==hash||v.recorded_by!==p.actor||v.sha256!==p.sha256||Number(v.byte_size)!==p.bytes||v.content_type!=='application/pdf'||v.version!==1||d.organization_id!==p.org||d.property_id!==null||d.title!==p.title||d.kind!==p.kind||d.head_version!==1)throw new RetainedRecoveryError('retained_document_identity_conflict');
  if(!allowed())deny();
  return {id:p.version,document_id:p.series,recovered:true,replayed:true};
 }
 if(!allowed())deny();
 await c.query('INSERT INTO commercial_documents(id,organization_id,property_id,title,kind,head_version) VALUES($1,$2,NULL,$3,$4,1)',[p.series,p.org,p.title,p.kind]);
 await c.query("INSERT INTO commercial_document_versions(id,document_id,version,object_key,sha256,byte_size,content_type,recorded_by,request_hash) VALUES($1::uuid,$2,1,$1::text,$3,$4,'application/pdf',$5,$6)",[p.version,p.series,p.sha256,p.bytes,p.actor,hash]);
 if(!allowed())deny();
 return {id:p.version,document_id:p.series,recovered:true,replayed:false};
}
