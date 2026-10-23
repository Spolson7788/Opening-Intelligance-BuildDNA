import {useEffect,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {useAuth} from '../lib/AuthContext';
import {loadAuth} from '../lib/db';
import {fetchLifecycle,saveInstallationFact} from '../lib/api';
import {componentLabel} from '../lib/serviceHistory';

function dateLabel(f:any){
 if(f.certainty==='unknown')return 'Installation date unknown';
 return [String(f.year).padStart(4,'0'),...(f.precision!=='year'?[String(f.month).padStart(2,'0')]:[]),...(f.precision==='day'?[String(f.day).padStart(2,'0')]:[])].join('-')+' ('+f.certainty+', '+f.precision+' precision)';
}
export function InstallationLifecyclePage(){const {id}=useParams(),{auth}=useAuth();return <InstallationForm key={`${id}:${auth?.userId}:${auth?.organizationId}`}/>;}
function InstallationForm(){
 const {id}=useParams(),{auth}=useAuth(),[principal]=useState(()=>auth!);
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<any>(null);
 const [target,setTarget]=useState(''),[certainty,setCertainty]=useState('unknown'),[precision,setPrecision]=useState('unknown');
 const [year,setYear]=useState(''),[month,setMonth]=useState(''),[day,setDay]=useState('');
 const [source,setSource]=useState('unknown'),[reference,setReference]=useState(''),[note,setNote]=useState(''),[reason,setReason]=useState('');
 useEffect(()=>{let active=true;fetchLifecycle(id!,principal).then(v=>{if(active){setData(v);setTarget('opening:'+id);}}).catch(e=>{if(active)setError(e.message);});
 const timer=setInterval(()=>{void loadAuth().then(a=>{if(active&&(!a||a.userId!==principal.userId||a.organizationId!==principal.organizationId)){setData(null);setPending(null);setError('Account changed. Reopen this record after signing in.');}});},1000);
 return()=>{active=false;clearInterval(timer);};},[id,principal]);
 const choices=data?[{type:'opening',id,label:'Whole opening'},...data.frames.map((f:any)=>({type:'frame',id:f.id,label:'Frame'})),...data.door_leaves.map((l:any)=>({type:'door_leaf',id:l.id,label:l.leaf_role+' leaf'})),...data.hardware_components.map((c:any)=>({type:'component',id:c.id,label:componentLabel(c,data)+(c.lifecycle_state==='retired'?' — retired':'')}))]:[];
 const selected=choices.find(c=>c.type+':'+c.id===target);
 const current=data?.installation_facts.find((f:any)=>f.is_current&&f.target.type===selected?.type&&f.target.id===selected?.id);
 const writable=['admin','facilities_manager'].includes(principal.role)&&data?.status!=='decommissioned';
 async function refresh(){setBusy(true);try{const v=await fetchLifecycle(id!,principal);setData(v);setTarget('opening:'+id);setPending(null);setError('');setReason('');}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 async function save(){
  if(!pending&&!selected){setError('Choose an available installation target.');return;}
  setBusy(true);setError('');setStatus('');
  const command=pending||{operation_id:crypto.randomUUID(),entity_id:crypto.randomUUID(),opening_id:id,device_id:crypto.randomUUID(),schema_version:3,app_version:'wp3-installation',protocol_version:1,expected_revision:data.revision,
   payload:{target:{type:selected.type,id:selected.id},date:{certainty,precision,year:certainty==='unknown'?null:Number(year),month:precision==='month'||precision==='day'?Number(month):null,day:precision==='day'?Number(day):null},source_type:source,source_reference:reference,note,correction_of:current?.id??null,correction_reason:current?reason:''}};
  setPending(command);
  try{await saveInstallationFact(command,principal);setStatus('Installation fact recorded. Previous facts and service history are preserved.');await refresh();}
  catch(e:any){setError(e.message+' — Submission outcome may need reconciliation. Retry sends the identical request; reload saved facts before changing it.');}
  finally{setBusy(false);}
 }
 return <div className="app-shell lifecycle-screen"><div className="top-bar"><h1>Installation and service history</h1></div><div className="screen">
  <Link to={`/opening/${id}`}>Opening record</Link><p><Link to={`/opening/${id}/lifecycle-records`}>Replacement, downtime and warranty records</Link></p><p>Installation comes first. Unknown dates remain undated; recording time is separate from installation time.</p>
  <p>This screen requires a connection. It does not queue offline changes.</p>
  {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
  {data&&<><h2>{data.opening_code} — Installation</h2>
   {choices.map(c=>{const facts=data.installation_facts.filter((f:any)=>f.target.type===c.type&&f.target.id===c.id);const legacy=data.legacy_installation_dates.filter((f:any)=>f.target.type===c.type&&f.target.id===c.id);return <section key={c.type+':'+c.id}><h3>{c.label}</h3>
    {!facts.length&&<p>No reviewed installation fact. Installation date unknown.</p>}
    {facts.map((f:any)=><article key={f.id}><p>{dateLabel(f)} — {f.is_current?'Current fact':'Superseded fact'}</p><p>Source: {f.source_type} {f.source_reference||'(not supplied)'}</p><p>{f.note}</p><p>Recorded: {f.recorded_at}</p>{f.correction_of&&<p>Correction: {f.correction_reason}</p>}</article>)}
    {legacy.map((v:any)=><p key={v.date}>Legacy date {v.date} — unreviewed source value, not confirmed installation.</p>)}
   </section>;})}
   {writable?<form onSubmit={e=>{e.preventDefault();void save();}}><h2>Record installation fact or correction</h2><fieldset disabled={busy||!!pending}>
    <label>Installation target<select value={target} onChange={e=>{setTarget(e.target.value);setReason('');}}>{choices.map(c=><option key={c.type+':'+c.id} value={c.type+':'+c.id}>{c.label}</option>)}</select></label>
    {current&&<p>This appends a correction to the current fact; the previous value remains visible.</p>}
    <label>Date certainty<select value={certainty} onChange={e=>{setCertainty(e.target.value);setPrecision(e.target.value==='unknown'?'unknown':'year');}}><option value="unknown">Unknown</option><option value="estimated">Estimated</option><option value="confirmed">Confirmed</option></select></label>
    {certainty!=='unknown'&&<><label>Date precision<select value={precision} onChange={e=>setPrecision(e.target.value)}><option value="year">Year</option><option value="month">Month</option><option value="day">Day</option></select></label><label>Year<input required type="number" min="1" max="9999" value={year} onChange={e=>setYear(e.target.value)}/></label>{precision!=='year'&&<label>Month<input required type="number" min="1" max="12" value={month} onChange={e=>setMonth(e.target.value)}/></label>}{precision==='day'&&<label>Day<input required type="number" min="1" max="31" value={day} onChange={e=>setDay(e.target.value)}/></label>}</>}
    <label>Evidence source<select value={source} onChange={e=>setSource(e.target.value)}>{['unknown','installation_record','maintenance_log','invoice','provider','recollection'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label>Source reference<input maxLength={1000} required={certainty==='confirmed'} value={reference} onChange={e=>setReference(e.target.value)}/></label><p>Confirmed dates require an identified evidence source; recollection remains estimated.</p>
    <label>Installation notes<textarea maxLength={4000} value={note} onChange={e=>setNote(e.target.value)}/></label>
    {current&&<label>Correction reason<input required maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   </fieldset><button className="btn btn-primary" disabled={busy} type="submit">{pending?'Retry identical submission':'Save installation fact'}</button></form>:<p>Installation facts are read-only for this account or retired opening.</p>}
   <button className="btn btn-secondary" disabled={busy} onClick={()=>void refresh()}>Reload saved facts</button>
   <h2>Recorded service history</h2><p>Service events retain their original identities and dates. Installation facts do not create service events or change condition.</p>
   {data.service_events.length?data.service_events.map((s:any)=><article key={s.id}><p>{s.event_date} — {s.work_performed}</p><p>Target: {s.hardware_component_id?choices.find(c=>c.type==='component'&&c.id===s.hardware_component_id)?.label||'Component record unavailable':'Whole opening'}</p></article>):<p>No recorded service events.</p>}
  </>}
 </div></div>;
}
