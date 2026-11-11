import {api,readFieldSession,requireFacilityOfficePage} from './api-client.mjs';
if(!(await requireFacilityOfficePage())) throw Error('facility_dashboard_forbidden');
const $=id=>document.getElementById(id),anchor=new URLSearchParams(location.search).get('opening');
const principal=await readFieldSession();
let epoch=0,data=null,loading=false,exporting=false,lost=false;
const tables=['openings','frames','door_leaves','hardware_components','installation_facts','condition_observations','lifecycle_records','replacements','positions','service_events'];
const same=p=>!!p&&!!principal&&p.userId===principal.userId&&p.organizationId===principal.organizationId&&p.token===principal.token;
function lock(){$('exportReport').disabled=!data||loading||exporting||lost;}
function lose(){lost=true;epoch++;data=null;$('content').replaceChildren();$('account').textContent='';$('error').textContent='Account changed. Reopen this page.';lock();}
function reportOf(value){
 if(!value||value.report_type!=='facility_condition_lifecycle_evidence'||value.report_version!==1||value.access_anchor_opening_id!==anchor||typeof value.property_id!=='string'||!Number.isFinite(Date.parse(value.as_of))||!Array.isArray(value.limitations))throw Error('Invalid report');
 for(const key of tables){if(!Array.isArray(value[key])||value[key].some(r=>!r||typeof r.id!=='string')||new Set(value[key].map(r=>r.id)).size!==value[key].length)throw Error('Invalid records');}
 const ids=new Set(value.openings.map(o=>o.id));if(!ids.has(anchor))throw Error('Missing anchor');
 for(const key of tables.filter(k=>k!=='openings'))if(value[key].some(r=>!ids.has(r.opening_id)))throw Error('Foreign opening');
 return Object.fromEntries(['report_type','report_version','scope','property_id','access_anchor_opening_id','as_of','limitations',...tables].map(k=>[k,value[k]]));
}
function text(parent,tag,value){const el=document.createElement(tag);el.textContent=value;parent.append(el);return el;}
function render(report){
 const root=$('content');root.replaceChildren();
 if($('facilityBack'))$('facilityBack').href='./?facility='+encodeURIComponent(report.property_id)+'&opening='+encodeURIComponent(anchor);
 const kpis=document.createElement('div');kpis.className='kpis';
 for(const [lab,val] of [['Openings',report.openings.length],['Parts',report.hardware_components.length],['Service events',report.service_events.length]]){const tile=document.createElement('article');tile.className='tile';const name=document.createElement('div');name.className='lab';name.textContent=lab;const value=document.createElement('div');value.className='val';value.textContent=String(val);tile.append(name,value);kpis.append(tile);}
 root.append(kpis);
 const about=document.createElement('details');about.className='method';text(about,'summary','Show details');text(about,'p',`Facility ${report.property_id}; saved snapshot ${report.as_of}. ${report.openings.length} openings, including retired records.`);
 const list=document.createElement('ul');about.append(list);for(const note of report.limitations)text(list,'li',note);root.append(about);
 const grouped=new Map();for(const key of tables.filter(k=>k!=='openings')){const groups=new Map();for(const record of report[key]){if(!groups.has(record.opening_id))groups.set(record.opening_id,[]);groups.get(record.opening_id).push(record);}grouped.set(key,groups);}
 for(const opening of report.openings){const card=document.createElement('article');card.className='card';root.append(card);const heading=text(card,'h2',`${opening.opening_code} — ${opening.status}`);heading.className='band-title';
  const aboutOpening=document.createElement('details');aboutOpening.className='method';text(aboutOpening,'summary','Show details');text(aboutOpening,'p',`Opening ID ${opening.id}. Legacy installation date: ${opening.install_date??'unknown'} (unreviewed).`);card.append(aboutOpening);
  for(const key of tables.filter(k=>k!=='openings')){const records=grouped.get(key).get(opening.id)||[];const section=document.createElement('details');card.append(section);text(section,'summary',`${key.replaceAll('_',' ')} (${records.length})`);
   let rendered=false;section.addEventListener('toggle',()=>{if(!section.open||rendered)return;rendered=true;
    for(const record of [...records].sort((a,b)=>String(a.recorded_at??a.event_date??'').localeCompare(String(b.recorded_at??b.event_date??''))||a.id.localeCompare(b.id))){text(section,'h3',record.id);if('correction_of' in record)text(section,'p',`${record.correction_of?'Correction of '+record.correction_of:'Original record'}; ${record.is_current?'not superseded':'superseded'}. Not a latest-condition score.`);text(section,'pre',JSON.stringify(record,null,2));}
   });
  }
 }
}
async function load(){if(lost)return;const version=++epoch;data=null;loading=true;$('content').replaceChildren();$('error').textContent='';lock();
 try{if(!anchor||!same(await readFieldSession())){lose();return;}const value=await api('/condition-history/facility/'+encodeURIComponent(anchor),undefined,principal);if(version!==epoch||lost)return;if(!same(await readFieldSession())){lose();return;}if(version!==epoch||lost)return;data=reportOf(value);render(data);$('status').textContent='Saved evidence loaded. No records changed.';}
 catch{if(version===epoch&&!lost)$('error').textContent='Evidence unavailable. Check access and refresh; no partial report is exported.';}
 finally{if(version===epoch)loading=false;lock();}
}
async function download(){if(!data||loading||exporting||lost)return;const saved=data,version=epoch;exporting=true;lock();
 try{if(!same(await readFieldSession())){lose();return;}if(version!==epoch||data!==saved||loading||lost)return;const report=reportOf(saved);const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}));const link=document.createElement('a');
  try{link.href=url;link.download='facility-condition-lifecycle-evidence.json';document.body.append(link);link.click();}finally{link.remove();URL.revokeObjectURL(url);}
  $('status').textContent='Facility condition/lifecycle evidence downloaded with its original snapshot time. No records changed.';
 }catch{if(!lost)$('error').textContent='Export unavailable. Refresh saved evidence.';}finally{exporting=false;lock();}
}
$('back').href='./planning.html?opening='+encodeURIComponent(anchor||'');
$('account').textContent=principal?`Account ${principal.userId} · Organization ${principal.organizationId}`:'';
$('reload').onclick=()=>void load();$('exportReport').onclick=()=>void download();
setInterval(async()=>{if(!same(await readFieldSession()))lose();},1000);
await load();
