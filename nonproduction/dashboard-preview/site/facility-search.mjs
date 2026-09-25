// Filters only rows already returned under database RLS. Never an authorization boundary.
export function filterFacilities(rows,{state='',query=''}={}) {
  const term=query.trim().toLocaleLowerCase(),region=state.trim().toUpperCase();
  return rows.filter(f=>(!region||String(f.state||'').trim().toUpperCase()===region)&&
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
export function mountFacilitySearch(container,rows,onSelect,{homeState=''}={}){
  const doc=container.ownerDocument;
  const label=(text,control)=>{const el=doc.createElement('label');el.textContent=text+' ';control.setAttribute('aria-label',text);el.append(control);return el;};
  const state=doc.createElement('select'),search=doc.createElement('input'),select=doc.createElement('select'),status=doc.createElement('span');
  const option=(value,text)=>{const o=doc.createElement('option');o.value=value;o.textContent=text;return o;};
  state.append(option('','All authorized states'));
  const states=new Set(rows.map(f=>String(f.state||'').trim().toUpperCase()).filter(Boolean));
  if(homeState)states.add(homeState);
  [...states].sort().forEach(s=>state.append(option(s,s)));
  state.value=homeState;search.type='search';search.placeholder='Name, address, city or ZIP';
  status.setAttribute('role','status');
  container.replaceChildren(label('State',state),label('Find facility',search),label('Facility',select),status);
  const render=()=>{
    const before=select.value,filtered=filterFacilities(rows,{state:state.value,query:search.value});
    select.replaceChildren(...filtered.map(f=>option(f.id,[f.name,f.city,f.state].filter(Boolean).join(' — '))));
    if(filtered.some(f=>f.id===before))select.value=before;
    select.disabled=!filtered.length;status.textContent=filtered.length+' authorized facilities';
    // No hidden selection when filters yield zero results.
    onSelect(filtered.find(f=>f.id===select.value)||null);
  };
  select.onchange=()=>onSelect(rows.find(f=>f.id===select.value)||null);
  state.onchange=render;search.oninput=render;render();
  return {state,search,select};
}
