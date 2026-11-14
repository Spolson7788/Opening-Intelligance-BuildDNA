// Same-origin, authenticated reads of canonical Field App records. No copied data.
export const FACILITY_DASHBOARD_SIGN_IN = "/field/login?next=" + encodeURIComponent("/facility-dashboard/");
const officeSignIn = `<p><a href="${FACILITY_DASHBOARD_SIGN_IN}">Sign in and return here</a></p>`;
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
export function dashboardError(status, payload) {
  const code = payload && typeof payload.error === "string" ? payload.error : "";
  if (status === 401) return "Sign in again to continue.";
  if (status === 403 || code === "facility_dashboard_forbidden") return "You do not have permission to do that for this company.";
  if (status === 404) return "Those records were not found for this company.";
  if (code === "invalid_review") return "Purchasing review was refused because too many openings were sent at once.";
  if (status >= 500) return "The server could not load those records. Reload to retry.";
  if (code) return "The request was refused: " + code.replaceAll("_", " ") + ".";
  return "The request was refused. Reload to retry.";
}
export async function reviewPurchasing(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const parts = [];
  for (const chunk of chunks) parts.push(await api("/purchasing/review", { opening_ids: chunk }));
  if (parts.length === 1) return parts[0];
  const openings = parts.flatMap((part) => part.openings || []);
  const decisions = parts.flatMap((part) => part.decisions || []);
  const blocked = parts.some((part) => part.blocked);
  return {
    review_only: true, nothing_sent_or_ordered: true, blocked, openings, decisions,
    items: blocked ? [] : decisions.filter((item) => item.eligible),
    excluded: decisions.filter((item) => !item.replacement_required),
    status: blocked ? "blocked" : decisions.some((item) => item.eligible) ? "eligible" : "no_replacements",
  };
}
export async function api(path, body, expectedPrincipal) {
  const before=await readFieldSession();if(!before)throw Error('Sign in through the Field App.');
  if(expectedPrincipal&&(before.userId!==expectedPrincipal.userId||before.organizationId!==expectedPrincipal.organizationId||before.token!==expectedPrincipal.token))throw Error('Account changed. Reopen the Dashboard.');
  const response=await fetch('/api'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+before.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});
  const payload=await response.json().catch(()=>null);
  const after=await readFieldSession();
  if(!after||after.userId!==before.userId||after.organizationId!==before.organizationId||after.token!==before.token)throw Error('Account changed. Reload the Dashboard.');
  if(!response.ok&&path.startsWith('/commercial/'))throw Error(String(payload?.error||'Commercial records unavailable').replace(/_/g,' '));
  if(!response.ok)throw Error(dashboardError(response.status, payload));
  if(payload===null)throw Error('Invalid response. Reload saved records.');
  return payload;
}
export async function requireFacilityOfficePage() {
  const session = await readFieldSession();
  if (!session) {
    document.body.innerHTML = '<main class="sheet"><h1>Facility Dashboard</h1><p>Sign in to open the facility dashboard.</p>' + officeSignIn + '</main>';
    return false;
  }
  try {
    const access = await api('/portfolio/facility-dashboard-access');
    if (!access || access.allowed !== true) throw Error('denied');
    return true;
  } catch {
    document.body.innerHTML = '<main class="sheet"><h1>Facility Dashboard</h1><p role="alert">This account cannot open the facility dashboard for the company you are signed in to. A facility administrator can open it. Opening Intelligence staff can open it when they already belong to that company as an administrator or facilities manager.</p>' + officeSignIn + '</main>';
    return false;
  }
}
export async function downloadFacilityVisitPdf(facilityId, visitId) {
  const session = await readFieldSession();
  if (!session) throw Error('Sign in through the Field App.');
  const response = await fetch('/api/portfolio/facility-dashboard/' + encodeURIComponent(facilityId) + '/inspection-visits/' + encodeURIComponent(visitId) + '/report.pdf', {
    headers: { Authorization: 'Bearer ' + session.token }, cache: 'no-store',
  });
  if (response.status === 404) throw Error('Official PDF not stored yet.');
  if (!response.ok) throw Error('Access unavailable. Sign in again or contact your administrator.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'fire-door-inspection-visit.pdf';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Same wording as the Field App (field-app/src/lib/serviceHistory.ts componentLabel).
export function componentLabel(h,o){
  const type=String(h.component_type||'').replace(/_/g,' ');
  const leaf=h.door_leaf_id?(o.door_leaves||[]).find(l=>l.id===h.door_leaf_id):null;
  const place=leaf?(leaf.leaf_role==='single'?'door':leaf.leaf_role+' leaf'):(h.mounting_scope==='frame'||h.frame_id?'frame':'');
  const model=[h.manufacturer,h.model_number].filter(Boolean).join(' ');
  return [type.charAt(0).toUpperCase()+type.slice(1),place,model].filter(Boolean).join(' · ');
}
export function latestComponentServiceDate(events, componentId) {
  return (events || []).filter(e => e.hardware_component_id === componentId)
    .map(e => e.event_date).filter(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10) === date)
    .sort().at(-1) || null;
}
export function mapSnapshot(snapshot) {
  const tables={opening_assemblies:[],opening_structure:[],opening_components:[],service_events:[],assembly_photos:[],opening_last_inspection:[],work_records:[]};
  for(const o of snapshot.openings||[]){
    const base={facility_id:snapshot.id,assembly_id:o.id,opening_no:o.opening_code,area:[o.building_name,o.floor_label,o.location_description].filter(Boolean).join(' · '),fire_rated:o.fire_rated,opening_health_score:o.health_score===null?null:Number(o.health_score),completion_state:o.completion_state};
    tables.opening_assemblies.push({...base,id:o.id});
    if(!o.frame&&!(o.door_leaves||[]).length&&!(o.hardware_components||[]).length)tables.opening_structure.push({...base,id:o.id,kind:'opening',material:'No parts saved',condition:'unverified',placeholder:true});
    if(o.frame)tables.opening_structure.push({...base,...o.frame,id:o.frame.id,kind:'frame',condition:o.frame.condition||'unverified'});
    for(const l of o.door_leaves||[])tables.opening_structure.push({...base,...l,kind:l.leaf_role==='single'?'door':l.leaf_role+'_leaf',condition:l.condition||'unverified'});
    for(const h of o.hardware_components||[])tables.opening_components.push({...base,...h,component_class:h.component_type.toUpperCase(),model:h.model_number,structure_id:h.mounting_scope==='door_leaf'?h.door_leaf_id:h.mounting_scope==='frame'?h.frame_id:null,disposition:h.replacement_required&&['worn','failed'].includes(h.condition)?'replace':'record',repair_cost:h.unit_cost,last_service_event_date:latestComponentServiceDate(o.service_events,h.id),work_completed_at:null});
    // Each event keeps its component (if any) so the history can be shown per component; opening-level events stay apart.
    const comps=new Map([...(o.hardware_components||[]),...(o.retired_hardware_components||[])].map(h=>[h.id,h]));
    for(const e of o.service_events||[]){const h=e.hardware_component_id?comps.get(e.hardware_component_id):null;
      tables.service_events.push({...base,...e,performed_at:String(e.event_date).slice(0,10),component_id:h?h.id:null,component_label:h?componentLabel(h,o)+(h.lifecycle_state==='retired'?' (retired)':''):(e.hardware_component_id?'Component not on this opening':null)});}
    for(const p of o.photos||[])tables.assembly_photos.push({...base,...p,storage_path:p.id,component_id:p.related_entity_type==='hardware_component'?p.related_entity_id:null,structure_id:['frame','door_leaf'].includes(p.related_entity_type)?p.related_entity_id:null});
    const dates=(o.inspection_events||[]).filter(i=>i.inspection_type==='fire_door_nfpa80').map(i=>String(i.event_date).slice(0,10)).sort();
    if(dates.length)tables.opening_last_inspection.push({...base,last_inspected_at:dates.at(-1)});
    for(const w of o.work_records||[])tables.work_records.push({...base,...w,performed_on:w.performed_on?String(w.performed_on).slice(0,10):null,advised_on:w.advised_on?String(w.advised_on).slice(0,10):null});
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
