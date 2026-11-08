export function dashboardRows(assemblies, structures, components) {
  const parents=new Map(assemblies.map(a=>[a.id,a]));
  const nodes=new Map(structures.map(s=>[s.id,s]));
  const score=c=>({good:100,worn:68,failed:30})[c]??null;
  const base=r=>{const a=parents.get(r.assembly_id);if(!a||a.facility_id!==r.facility_id)throw Error('Invalid opening parent');return {...r,opening_no:a.opening_no,area:a.area,fire_rated:a.fire_rated,health_score:score(r.condition)};};
  return [...structures.map(s=>({...base(s),component_class:s.kind.toUpperCase(),manufacturer:null,model:s.material||'Material not recorded',hierarchy:s.kind})),...components.map(c=>{
    const n=c.structure_id?nodes.get(c.structure_id):null;
    if(c.structure_id&&(!n||n.assembly_id!==c.assembly_id))throw Error('Invalid component parent');
    return {...base(c),hierarchy:n?.kind||'opening'};
  })];
}
export async function loadDashboardRows(sb,facilityId) {
  const tables=['opening_assemblies','opening_structure','opening_components'];
  const results=await Promise.all(tables.map(t=>sb.from(t).select('*').eq('facility_id',facilityId)));
  const error=results.find(r=>r.error)?.error;if(error)return {error};
  return {data:dashboardRows(...results.map(r=>r.data||[]))};
}
function recordedCost(value) {
  if(value===null||value===undefined||value==='')return null;
  const amount=Number(value);
  return Number.isFinite(amount)&&amount>=0?Math.round(amount*100):null;
}
export function correctiveSummary(parts) {
  let cents=0,priced=0,unpriced=0;
  for(const part of parts) {
    if(part.disposition!=='replace'||part.work_completed_at)continue;
    const value=recordedCost(part.repair_cost);
    if(value===null)unpriced++;else{cents+=value;priced++;}
  }
  return {cost:cents/100,priced,unpriced};
}
export function serviceSummary(events) {
  let cents=0,unpriced=0;
  for(const event of events){const value=recordedCost(event.cost);if(value===null)unpriced++;else cents+=value;}
  return {cost:cents/100,count:events.length,unpriced};
}
export async function loadQuarterServiceSummary(sb,facilityId,now=new Date()) {
  const start=new Date(now.getFullYear(),Math.floor(now.getMonth()/3)*3,1).toISOString();
  const end=now.toISOString(),events=[],pageSize=500;
  for(let offset=0;;offset+=pageSize){
    const result=await sb.from('service_events').select('id,cost,performed_at')
      .eq('facility_id',facilityId).gte('performed_at',start).lte('performed_at',end)
      .order('id').range(offset,offset+pageSize-1);
    if(result.error)throw result.error;
    if(!Array.isArray(result.data))throw Error('Service data unavailable');
    events.push(...result.data);
    if(result.data.length<pageSize)break;
  }
  return serviceSummary(events);
}

// A PostgreSQL date is a calendar day, not a UTC instant to shift into local time.
export function formatCalendarDate(value,locale) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return 'Date unavailable';
  const date=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)return 'Date unavailable';
  return date.toLocaleDateString(locale,{timeZone:'UTC'});
}

export function readableLabel(value) {
  const text=String(value||'').replaceAll('_',' ').toLowerCase();
  return text ? text[0].toUpperCase()+text.slice(1) : '';
}
export function componentLabel(component,records=[]) {
  const parent=component.hierarchy||records.find(r=>r.id===component.structure_id)?.kind||(component.structure_id?'unknown parent':'opening');
  return [readableLabel(component.component_class)||'Component',readableLabel(parent),component.manufacturer,component.model].filter(Boolean).join(' — ');
}
export function photoScopeLabel(photo,records=[]) {
  if(photo.component_id){const component=records.find(r=>r.id===photo.component_id);return component?'Component: '+componentLabel(component,records):'Component unavailable';}
  if(photo.structure_id){const structure=records.find(r=>r.id===photo.structure_id);return structure?readableLabel(structure.kind||structure.hierarchy):'Structure unavailable';}
  return 'Opening';
}
