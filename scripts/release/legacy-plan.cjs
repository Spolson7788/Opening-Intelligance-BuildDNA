// Pure planning only: no database, credential, network, or write operations.
const {createHash} = require('node:crypto');
function identity(kind, key) {
  const h=createHash('sha256').update(JSON.stringify(['oi-legacy-v1',kind,key])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const TYPES={DOOR_CLOSER:'closer',EXIT_DEVICE:'exit_device',HINGE_BUTT:'hinge'};
function planLegacy(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.facilities) || !Array.isArray(snapshot.openings)) throw Error('Invalid legacy snapshot');
  const seen=new Set(), facilities=new Map(), groups=new Map(), archived=[];
  for(const f of snapshot.facilities) {
    if(typeof f.id!=='string'||!f.id||facilities.has(f.id)) throw Error('Missing or duplicate facility id');
    facilities.set(f.id,structuredClone(f));
  }
  for(const row of snapshot.openings) {
    if(typeof row.id!=='string'||!row.id||seen.has(row.id)) throw Error('Missing or duplicate component row id');
    seen.add(row.id);
    if(!facilities.has(row.facility_id)) throw Error('Unknown facility reference');
    if(typeof row.opening_no!=='string'||!row.opening_no.trim()) throw Error('Missing opening number');
    const key=JSON.stringify([row.facility_id,row.opening_no]);
    if(!groups.has(key)) groups.set(key,{id:identity('opening',key),legacy_facility_id:row.facility_id,legacy_opening_no:row.opening_no,completion_state:'draft',configuration:null,components:[],unresolved_structure:[]});
    const opening=groups.get(key);
    archived.push(structuredClone(row));
    const source={legacy_row_id:row.id,opening_id:opening.id};
    if(TYPES[row.component_class]) opening.components.push({...source,id:identity('component',row.id),component_type:TYPES[row.component_class],manufacturer:row.manufacturer??null,model_number:row.model??null,condition:'unverified',identity_status:'unresolved',review_state:'pending',replacement_required:false,mounting_scope:null});
    else opening.unresolved_structure.push({...source,legacy_class:row.component_class??null});
  }
  const openings=[...groups.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const facilityPlans=[...facilities.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(f=>({legacy_id:f.id,name:f.name??null,organization_id:null,provider_assignments:[],state:null,territory:null}));
  for(const o of openings) {
    o.components.sort((a,b)=>a.id.localeCompare(b.id));
    o.unresolved_structure.sort((a,b)=>a.legacy_row_id.localeCompare(b.legacy_row_id));
  }
  archived.sort((a,b)=>a.id.localeCompare(b.id));
  return {format:'oi-legacy-conversion-plan-v1',executable:false,blockers:['facility ownership and geography mapping required','account and membership transition required','opening configuration and mounting targets require review','all legacy tables require preservation before cutover'],counts:{facilities:facilities.size,legacy_rows:seen.size,physical_openings:openings.length,hardware:openings.reduce((n,o)=>n+o.components.length,0),unresolved_structure:openings.reduce((n,o)=>n+o.unresolved_structure.length,0)},facilities:facilityPlans,openings,legacy_rows:archived};
}
module.exports={planLegacy};
