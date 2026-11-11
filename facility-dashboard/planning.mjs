import {api,readFieldSession,requireFacilityOfficePage} from './api-client.mjs';
if(!(await requireFacilityOfficePage())) throw Error('facility_dashboard_forbidden');
const $=id=>document.getElementById(id),opening=new URL(location.href).searchParams.get('opening'),principal=await readFieldSession();
let data,commercial,pending=null,busy=false,sessionLost=false;
let loading=false,exporting=false;
const value=id=>$(id).value,call=(p,b)=>api(p,b,principal);
function text(parent,tag,s){const e=document.createElement(tag);e.textContent=s;parent.append(e);return e;}
function options(id,rows,first){$(id).replaceChildren();if(first)$(id).add(new Option(first,''));for(const [v,l] of rows)$(id).add(new Option(l,v));}
function lock(){const fieldset=$('draftForm')?.querySelector('fieldset');if(fieldset)fieldset.disabled=loading||busy||!!pending||sessionLost;$('retry').hidden=!pending||sessionLost;$('retry').disabled=busy;$('exportReport').disabled=!data||loading||busy||exporting||sessionLost;}
function samePrincipal(p){return !!p&&!!principal&&p.userId===principal.userId&&p.organizationId===principal.organizationId&&p.token===principal.token;}
function loseSession(){sessionLost=true;pending=null;data=undefined;commercial=undefined;$('content').replaceChildren();$('retry').hidden=true;$('error').textContent='Account changed. Reopen from the Facility Dashboard.';lock();}
async function exportReport(){
 if(!data||loading||busy||exporting||sessionLost)return;
 const saved=data;exporting=true;lock();
 try{
  if(!samePrincipal(await readFieldSession())){loseSession();return;}
  if(sessionLost||loading||data!==saved)return;
  // Export only the authorized planning projection, never the session or commercial upload context.
  const report={report_type:'opening_planning',report_version:1,scope:'one_opening',limitations:['Descriptive recorded condition, not comparative reliability.','Sandbox drafts are not approvals, commitments or issued orders.','Unknown costs and exposure remain unknown; no combined financial total is calculated.'],opening_id:saved.opening_id,opening_code:saved.opening_code,as_of:saved.as_of,configuration_gaps:saved.configuration_gaps,condition:saved.condition,lifecycle:saved.lifecycle,versions:saved.versions,events:saved.events,financial:saved.financial};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'})),link=document.createElement('a');
  try{link.href=url;link.download='opening-planning-report.json';document.body.append(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);}
  $('status').textContent='Opening planning report downloaded. It contains saved records only, with their recorded as-of time.';
 }catch{ $('error').textContent='Report export unavailable. Refresh saved records before trying again.'; }
 finally{exporting=false;lock();}
}
async function send(path,body){if(busy||sessionLost)return;if(pending&&(pending.path!==path||JSON.stringify(pending.body)!==JSON.stringify(body))){$('error').textContent='A different submission is pending. Retry it or refresh saved records first.';return;}pending??={path,body};busy=true;lock();try{await call(path,body);pending=null;await load();$('status').textContent='Sandbox record saved. Nothing approved, ordered or sent.';}catch(e){$('error').textContent=e.message;}finally{busy=false;lock();}}
async function load(){
 if(sessionLost)throw Error('Account changed. Reopen from the Facility Dashboard.');
 loading=true;data=undefined;lock();
 try{
 const [p,c]=await Promise.all([call('/planning/'+encodeURIComponent(opening)),call('/commercial/context/'+encodeURIComponent(opening))]);
 if(sessionLost||!samePrincipal(await readFieldSession())){loseSession();return;}
 commercial=c;
 $('content').hidden=false;$('opening').textContent=p.opening_code;$('asOf').textContent='As of '+p.as_of;$('gaps').replaceChildren();for(const gap of p.configuration_gaps)text($('gaps'),'li',gap.replaceAll('_',' '));
 if($('sumGaps'))$('sumGaps').textContent=String(p.configuration_gaps.length);
 if($('sumDrafts'))$('sumDrafts').textContent=String(p.versions.filter(v=>v.is_current).length);
 if($('sumService'))$('sumService').textContent=String(p.lifecycle.service_event_count);
 if($('facilityBack')&&c.property_id)$('facilityBack').href='./?facility='+encodeURIComponent(c.property_id)+'&opening='+encodeURIComponent(opening);
 $('draftForm').hidden=!p.sandbox_enabled||!['admin','facilities_manager'].includes(principal.role);
 if($('editDraft'))$('editDraft').hidden=$('draftForm').hidden;
 $('draftForm').classList.remove('is-open');
 $('status').textContent=p.sandbox_enabled?'Local sandbox drafting enabled.':'Sandbox drafting is disabled in this runtime.';
 const current=p.versions.filter(v=>v.is_current);options('series',current.map(v=>[v.plan_id,`${v.snapshot.label} v${v.version}`]),'New series');options('estimate',c.estimates.map(e=>[e.id,`${e.id} v${e.version} — ${e.stale?'expired':e.superseded?'superseded':'current'}; ${e.snapshot.totals.total_minor??'unknown'} ${e.snapshot.currency} minor units`]));
 $('conditionMethod').textContent=`${p.condition.method}; minimum ${p.condition.threshold} assessed parts per displayed cohort. Worn + failed / assessed. Unverified excluded; this is not a reliability rating. Excluded manufacturer labels: ${p.condition.excluded_manufacturer_count}.`;
 $('cohorts').replaceChildren();for(const g of p.condition.cohorts)text($('cohorts'),'article',`${g.manufacturer} / ${g.model||'model unknown'} / ${g.component_type}: ${g.installed} current, ${g.assessed} assessed, ${g.worn_failed} worn/failed, ${g.unverified} unverified. Rate ${g.rate_withheld?'withheld: sample below threshold':(100*g.rate).toFixed(1)+'%'}.`);
 const l=p.lifecycle;$('lifecycle').textContent=`${l.current_component_count} current components; ${l.installation_unknown_count} installation dates unknown; ${l.recorded_replacements} recorded replacements; ${l.service_event_count} unique service events. Exposure and comparative reliability unavailable.`;
 $('downtime').textContent=Object.entries(l.downtime).map(([k,v])=>`${k}: ${v.record_count} recorded intervals; ${v.guaranteed_minutes} guaranteed recorded minutes, ${v.possible_minutes??'unknown'} possible recorded minutes; ${v.unresolved_intervals} unresolved intervals`).join('. ');
 $('financial').textContent='Approval reservations, issued commitments and recognized actual costs: unavailable. An accounting policy and accepted cost evidence are required.';
 $('versions').replaceChildren();for(const v of p.versions){const s=v.snapshot,e=s.estimate,a=text($('versions'),'article','');text(a,'h3',`${s.label} — ${s.kind} v${v.version}${v.is_current?' (current)':' (superseded)'}`);text(a,'p',`Snapshot SHA-256: ${v.snapshot_hash}`);text(a,'p',`Estimate ${s.estimate_version_id}; ${e.totals.total_minor??'unknown'} ${e.currency} minor units (${e.minor_unit_digits} digits); missing: ${e.totals.missing.join(', ')||'none'}; ${v.estimate_expired?'expired':'not expired'}; source quote ${v.estimate_currently_superseded?'currently superseded':'current'}; ${s.estimate_superseded_at_draft?'already superseded when drafted':'current when drafted'}.`);text(a,'p',`Fiscal period: ${s.fiscal_period||'not specified'}. Assumptions: ${s.assumptions||'not supplied'}.`);text(a,'p',`Review requested: ${v.review_requested?'yes':'no'}. Delivery: ${v.delivery_state||'not queued'}. Financial approval: unavailable. Issued: no.`);if(v.is_current&&s.kind==='order'&&p.sandbox_enabled&&['admin','facilities_manager'].includes(principal.role)){const b=text(a,'button','Request sandbox review');b.className='tool green';b.onclick=()=>void send('/planning/versions/'+v.id+'/request-review',{operation_id:crypto.randomUUID()});}const extra=[...a.querySelectorAll(':scope > p')];if(extra.length>1){const details=document.createElement('details');text(details,'summary','Show details');extra.slice(1).forEach(node=>details.append(node));a.append(details);}}
 $('events').replaceChildren();for(const e of p.events)text($('events'),'p',`${e.recorded_at}: ${e.action.replaceAll('_',' ')}; version ${e.version_id}; actor ${e.actor_id}; event ${e.id}`);
 $('draftForm').reset();
 data=p;
 }finally{loading=false;lock();}
}
$('series').onchange=()=>{const v=data.versions.find(v=>v.plan_id===value('series')&&v.is_current);if(v){$('kind').value=v.snapshot.kind;$('label').value=v.snapshot.label;$('period').value=v.snapshot.fiscal_period;$('assumptions').value=v.snapshot.assumptions;$('estimate').value=v.snapshot.estimate_version_id;}};
$('draftForm').onsubmit=e=>{e.preventDefault();const old=data.versions.find(v=>v.plan_id===value('series')&&v.is_current);if(value('kind')==='scenario'&&!value('period').trim()){$('error').textContent='Enter the fiscal period for this scenario.';return;}void send('/planning/versions',{id:old?.plan_id||crypto.randomUUID(),version_id:crypto.randomUUID(),expected_version:old?.version||0,opening_id:opening,kind:value('kind'),estimate_version_id:value('estimate'),label:value('label'),fiscal_period:value('period'),assumptions:value('assumptions')});};
$('retry').onclick=()=>pending&&send(pending.path,pending.body);$('reload').onclick=async()=>{if(busy||sessionLost)return;pending=null;lock();try{await load();$('error').textContent='';}catch(e){$('error').textContent=e.message;}};
$('financeLink').href='./finance.html?opening='+encodeURIComponent(opening);
$('exportReport').onclick=()=>void exportReport();
$('editDraft')?.addEventListener('click',()=>$('draftForm').classList.toggle('is-open'));
$('back').href='./commercial.html?opening='+encodeURIComponent(opening);
setInterval(async()=>{if(!samePrincipal(await readFieldSession()))loseSession();},1000);
try{if(!opening||!principal)throw Error('Sign in and select an opening.');await load();}catch(e){$('error').textContent=e.message;}

$('historyLink').href='./history.html?opening='+encodeURIComponent(opening);
