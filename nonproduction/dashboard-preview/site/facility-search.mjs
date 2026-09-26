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
export function mountFacilitySearch(container,rows,onSelect,{homeState='',homeTerritory='',homeTerritoryName=''}={}){
  const doc=container.ownerDocument;
  const label=(text,control)=>{const el=doc.createElement('label');el.textContent=text+' ';control.setAttribute('aria-label',text);el.append(control);return el;};
  const territory=doc.createElement('select'),state=doc.createElement('select'),search=doc.createElement('input'),select=doc.createElement('select'),status=doc.createElement('span');
  const option=(value,text)=>{const o=doc.createElement('option');o.value=value;o.textContent=text;return o;};
  territory.append(option('','All authorized territories'));
  const areas=new Map(rows.flatMap(f=>(f.territories||[]).map(t=>[t.key,t.name])));
  if(homeTerritory)areas.set(homeTerritory,homeTerritoryName);
  [...areas].sort((a,b)=>a[1].localeCompare(b[1])).forEach(([k,n])=>territory.append(option(k,n)));
  territory.value=homeTerritory;
  state.append(option('','All authorized states'));
  const states=new Set(rows.map(f=>String(f.state||'').trim().toUpperCase()).filter(Boolean));
  if(homeState)states.add(homeState);
  [...states].sort().forEach(s=>state.append(option(s,s)));
  state.value=homeState;search.type='search';search.placeholder='Name, address, city or ZIP';
  status.setAttribute('role','status');
  container.replaceChildren(label('My Territory',territory),label('State',state),label('Find facility',search),label('Facility',select),status);
  const render=()=>{
    const before=select.value,filtered=filterFacilities(rows,{state:state.value,query:search.value,territory:territory.value});
    select.replaceChildren(...filtered.map(f=>option(f.id,[f.name,f.city,f.state].filter(Boolean).join(' — '))));
    if(filtered.some(f=>f.id===before))select.value=before;
    select.disabled=!filtered.length;status.textContent=filtered.length+' authorized facilities';
    // No hidden selection when filters yield zero results.
    onSelect(filtered.find(f=>f.id===select.value)||null);
  };
  select.onchange=()=>onSelect(rows.find(f=>f.id===select.value)||null);
  territory.onchange=render;state.onchange=render;search.oninput=render;render();
  return {territory,state,search,select};
}
