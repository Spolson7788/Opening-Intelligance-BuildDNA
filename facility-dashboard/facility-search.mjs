// Filters only rows already returned under database RLS. Never an authorization boundary.
export function filterFacilities(rows,{state='',query='',territory=''}={}) {
  const term=query.trim().toLocaleLowerCase(),region=state.trim().toUpperCase();
  return rows.filter(f=>(!territory||(f.territories||[]).some(t=>t.key===territory))&&(!region||String(f.state||'').trim().toUpperCase()===region)&&
    (!term||[f.name,f.address,f.city,f.state,f.postal_code].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)));
}
export async function loadAuthorizedFacilities(sb) {
  const rows=[];
  for(let offset=0;;offset+=500){
    const {data,error}=await sb.from('facilities').select('id,name,address,city,state,postal_code').order('id').range(offset,offset+499);
    if(error)throw Error(error.message);
    if(!Array.isArray(data))throw Error('Facility list unavailable');
    rows.push(...data);if(data.length<500)break;
  }
  return rows.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
}
export async function defaultHomeState(sb){
  const {data,error}=await sb.from('provider_memberships').select('home_state');
  if(error)return ''; // Customer-only accounts and older schemas have no provider preference.
  const states=[...new Set((data||[]).map(m=>m.home_state).filter(Boolean))];
  return states.length===1?states[0]:'';
}
export async function loadTerritoryContext(sb,rows){
  const memberships=await sb.from('provider_memberships').select('provider_id,home_territory');
  const assignments=await sb.from('facility_provider_assignments').select('provider_id,facility_id,territory').order('facility_id').order('provider_id').range(0,499);
  if(memberships.error||assignments.error)throw Error('Territory settings unavailable. Retry when connected.');
  let all=[...(assignments.data||[])];
  for(let offset=500;(assignments.data||[]).length===500;offset+=500){
    const page=await sb.from('facility_provider_assignments').select('provider_id,facility_id,territory').order('facility_id').order('provider_id').range(offset,offset+499);
    if(page.error)throw Error('Territory settings unavailable.');
    all.push(...(page.data||[]));if((page.data||[]).length<500)break;
  }
  const key=(provider,name)=>JSON.stringify([provider,name]);
  const permitted=new Set((memberships.data||[]).map(m=>m.provider_id));
  const mapped=rows.map(f=>({...f,territories:all.filter(a=>a.facility_id===f.id&&permitted.has(a.provider_id)&&a.territory?.trim()).map(a=>({key:key(a.provider_id,a.territory.trim()),name:a.territory.trim()}))}));
  const defaults=[...new Set((memberships.data||[]).filter(m=>m.home_territory?.trim()).map(m=>key(m.provider_id,m.home_territory.trim())))];
  // Keep the default even with no facilities: never silently widen an empty service area.
  return {rows:mapped,homeTerritory:defaults.length===1?defaults[0]:'',homeTerritoryName:defaults.length===1?JSON.parse(defaults[0])[1]:''};
}
export function mountFacilitySearch(container,rows,onSelect){
  const doc=container.ownerDocument;
  const select=doc.createElement('select');
  select.setAttribute('aria-label','Facility');
  const label=doc.createElement('label');
  label.append('Facility ',select);
  const option=(value,text)=>{const o=doc.createElement('option');o.value=value;o.textContent=text;return o;};
  const named=[...rows].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''))||String(a.id).localeCompare(String(b.id)));
  container.replaceChildren(label);
  if(!named.length){
    select.append(option('','No authorized facilities'));
    select.disabled=true;
    onSelect(null);
    return {select};
  }
  if(named.length===1){
    select.append(option(named[0].id,named[0].name));
    select.value=named[0].id;
    select.onchange=()=>onSelect(named[0]);
    onSelect(named[0]);
    return {select};
  }
  select.append(option('','Choose a facility'));
  named.forEach(f=>select.append(option(f.id,f.name)));
  select.value='';
  select.onchange=()=>onSelect(named.find(f=>f.id===select.value)||null);
  onSelect(null);
  return {select};
}
