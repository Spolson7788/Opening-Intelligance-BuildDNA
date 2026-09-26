// Same-origin, authenticated reads of canonical Field App records. No copied data.
export async function readFieldSession() {
  return new Promise(resolve => {
    const request=indexedDB.open('opening-intel-field');
    request.onupgradeneeded=()=>request.transaction.abort();
    request.onerror=()=>resolve(null);
    request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('auth')){db.close();resolve(null);return;}
      const tx=db.transaction('auth','readonly'),get=tx.objectStore('auth').get('current');
      get.onsuccess=()=>resolve(get.result||null);get.onerror=()=>resolve(null);tx.oncomplete=()=>db.close();};
  });
}
export async function api(path) {
  const before=await readFieldSession();if(!before)throw Error('Sign in through the Field App.');
  const response=await fetch('/api'+path,{headers:{Authorization:'Bearer '+before.token},cache:'no-store'});
  const after=await readFieldSession();
  if(!after||after.userId!==before.userId||after.organizationId!==before.organizationId||after.token!==before.token)throw Error('Account changed. Reload the Dashboard.');
  if(!response.ok)throw Error([401,403,404].includes(response.status)?'Access unavailable. Sign in again or contact your administrator.':'Connected records unavailable. Reload to retry.');
  return response.json();
}
export function mapSnapshot(snapshot) {
  const tables={opening_assemblies:[],opening_structure:[],opening_components:[],service_events:[],assembly_photos:[],opening_last_inspection:[]};
  for(const o of snapshot.openings||[]){
    const base={facility_id:snapshot.id,assembly_id:o.id,opening_no:o.opening_code,area:[o.building_name,o.floor_label,o.location_description].filter(Boolean).join(' · '),fire_rated:o.fire_rated,opening_health_score:o.health_score===null?null:Number(o.health_score),completion_state:o.completion_state};
    tables.opening_assemblies.push({...base,id:o.id});
    if(!o.frame&&!(o.door_leaves||[]).length&&!(o.hardware_components||[]).length)tables.opening_structure.push({...base,id:o.id,kind:'opening',material:'No parts saved',condition:'unverified',placeholder:true});
    if(o.frame)tables.opening_structure.push({...base,...o.frame,id:o.frame.id,kind:'frame',condition:o.frame.condition||'unverified'});
    for(const l of o.door_leaves||[])tables.opening_structure.push({...base,...l,kind:l.leaf_role==='single'?'door':l.leaf_role+'_leaf',condition:l.condition||'unverified'});
    for(const h of o.hardware_components||[])tables.opening_components.push({...base,...h,component_class:h.component_type.toUpperCase(),model:h.model_number,structure_id:h.mounting_scope==='door_leaf'?h.door_leaf_id:h.mounting_scope==='frame'?h.frame_id:null,disposition:h.replacement_required&&['worn','failed'].includes(h.condition)?'replace':'record',repair_cost:h.unit_cost,work_completed_at:null});
    for(const e of o.service_events||[])tables.service_events.push({...base,...e,performed_at:String(e.event_date).slice(0,10)});
    for(const p of o.photos||[])tables.assembly_photos.push({...base,...p,storage_path:p.id,component_id:p.related_entity_type==='hardware_component'?p.related_entity_id:null,structure_id:['frame','door_leaf'].includes(p.related_entity_type)?p.related_entity_id:null});
    const dates=(o.inspection_events||[]).filter(i=>i.inspection_type==='fire_door_nfpa80').map(i=>String(i.event_date).slice(0,10)).sort();
    if(dates.length)tables.opening_last_inspection.push({...base,last_inspected_at:dates.at(-1)});
  }
  return tables;
}
let snapshot=null,scope=null,loadEpoch=0;
export async function refreshFacility(id){const epoch=++loadEpoch;snapshot=null;const data=await api('/portfolio/facility-dashboard/'+encodeURIComponent(id));if(epoch!==loadEpoch)throw Error('Facility selection changed.');snapshot={id,tables:mapSnapshot(data)};return snapshot.tables;}
export async function refreshScope(){scope=await api('/portfolio/facility-search');return scope;}
class Query {
 constructor(table){this.table=table;this.filters=[];this.start=0;this.end=Infinity;}
 select(){return this;} eq(k,v){this.filters.push(r=>r[k]===v);return this;}
 gte(k,v){this.filters.push(r=>String(r[k])>=String(v).slice(0,10));return this;}
 lte(k,v){this.filters.push(r=>String(r[k])<=String(v));return this;}
 order(k,{ascending=true}={}){this.sort=[k,ascending];return this;} range(a,b){this.start=a;this.end=b+1;return this;} limit(n){this.end=n;return this;}
 maybeSingle(){this.single=true;return this;}
 async execute(){try{
  let rows;
  if(this.table==='profiles'){const a=await readFieldSession();rows=a?[{id:a.userId,user_type:a.role}]:[];}
  else if(this.table==='facilities')rows=(scope||await refreshScope()).facilities.map(f=>({...f,address:f.address_line1}));
  else if(this.table==='provider_memberships'){const s=scope||await refreshScope();rows=[{provider_id:'current-company',home_state:s.preferences.home_state,home_territory:s.preferences.home_territory}];}
  else if(this.table==='facility_provider_assignments')rows=(scope||await refreshScope()).facilities.map(f=>({provider_id:'current-company',facility_id:f.id,territory:f.service_territory}));
  else {if(!snapshot)throw Error('Select a facility first.');rows=snapshot.tables[this.table];if(!rows)throw Error('This record type is not connected: '+this.table);}
  rows=rows.filter(r=>this.filters.every(f=>f(r)));if(this.sort){const[k,a]=this.sort;rows=[...rows].sort((x,y)=>String(x[k]??'').localeCompare(String(y[k]??''))*(a?1:-1));}rows=rows.slice(this.start,this.end);
  return {data:this.single?(rows[0]||null):rows,error:null};
 }catch(e){return {data:null,error:{message:e.message}};}}
 then(resolve,reject){return this.execute().then(resolve,reject);}
}
export const sb={
 from:table=>new Query(table),
 auth:{
  getSession:async()=>{const a=await readFieldSession();return {data:{session:a?{user:{id:a.userId}}:null}};},
  signInWithPassword:async()=>({error:{message:'Use the Field App sign-in link.'}}),
  resetPasswordForEmail:async()=>({error:{message:'Use your Field App account recovery.'}}),
  signOut:async()=>{const a=await readFieldSession();if(a)await new Promise((resolve,reject)=>{const r=indexedDB.open('opening-intel-field');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('auth','readwrite');t.objectStore('auth').delete('current');t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});scope=null;snapshot=null;}
 },
 storage:{from:()=>({createSignedUrl:async id=>{try{const r=await api('/photos/'+encodeURIComponent(id)+'/access');return {data:{signedUrl:r.url},error:null};}catch(e){return {data:null,error:{message:e.message}};}}})}
};
