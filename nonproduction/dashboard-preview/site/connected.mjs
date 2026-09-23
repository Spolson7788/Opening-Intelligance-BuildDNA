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
