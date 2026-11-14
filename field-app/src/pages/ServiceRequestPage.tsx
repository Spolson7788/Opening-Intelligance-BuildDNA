import {useEffect,useState} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {useAuth} from '../lib/AuthContext';
import {fetchServiceRequestContext,isClientPrincipalChange} from '../lib/api';
import {getOfflineSetting,putOfflineSetting,loadAuth,getSyncOperationsForPrincipal} from '../lib/db';
import {queueOpeningMutation,onSyncStateChange} from '../lib/sync';
import {componentLabel} from '../lib/serviceHistory';
import {SyncBadge} from '../components/SyncBadge';

export function ServiceRequestPage(){
  const {id}=useParams();const {auth}=useAuth();
  return <ServiceRequestForm key={`${id}:${auth?.userId}:${auth?.organizationId}`}/>;
}
function ServiceRequestForm(){
  const {id}=useParams(),{auth}=useAuth(),[query]=useSearchParams();
  const [principal]=useState(()=>auth!);
  const [context,setContext]=useState<any>(null),[offline,setOffline]=useState(false),[error,setError]=useState('');
  const [selected,setSelected]=useState<string[]>([]),[uncertain,setUncertain]=useState(false),[photos,setPhotos]=useState<string[]>([]);
  const [provider,setProvider]=useState(''),[symptom,setSymptom]=useState(''),[impact,setImpact]=useState(''),[priority,setPriority]=useState('normal');
  const [review,setReview]=useState(false),[saving,setSaving]=useState(false),[operation,setOperation]=useState(''),[status,setStatus]=useState('');
  const [operationId,setOperationId]=useState(()=>crypto.randomUUID());
  useEffect(()=>{
    let active=true;const key=`service-request-context:${principal.organizationId}:${principal.userId}:${id}`;
    const run=async()=>{
      try{
        let value;
        try{value=await fetchServiceRequestContext(id!,principal);await putOfflineSetting({key,value,updatedAt:new Date().toISOString()});}
        catch(e){if(!(e instanceof TypeError))throw e;value=(await getOfflineSetting(key))?.value;if(!value)throw Error('Open this request screen once while connected before using it offline.');if(active)setOffline(true);}
        const current=await loadAuth();if(!current||current.userId!==principal.userId||current.organizationId!==principal.organizationId)throw Error('Account changed. Close this form and sign in again.');
        const pending=(await getSyncOperationsForPrincipal(principal.userId,principal.organizationId)).filter(r=>r.openingId===id&&r.entityType==='service_request'&&r.state!=='verified');
        if(active){setContext(value);if(pending.length){setOperation(pending[0].operationId);setStatus('A request is already saved on this device for this opening. Checking synchronization status.');}
          const component=query.get('component');if(value.hardware_components.some((c:any)=>c.id===component))setSelected(['component:'+component]);}
      }catch(e){if(active)setError(e instanceof Error?e.message:'Request details unavailable.');}
    };void run();return()=>{active=false;};
  },[id,principal,query]);
  useEffect(()=>{
    const timer=setInterval(()=>{void loadAuth().then(current=>{
      if(!current||current.userId!==principal.userId||current.organizationId!==principal.organizationId){setContext(null);setOperation('');setReview(false);setError('Account changed. Close this form and sign in again.');}
    });},1000);return()=>clearInterval(timer);
  },[principal]);
  useEffect(()=>{
    if(!operation)return;
    return onSyncStateChange(()=>{void getSyncOperationsForPrincipal(principal.userId,principal.organizationId).then(rows=>{
      const row=rows.find(r=>r.operationId===operation);if(!row)return;
      setStatus(row.state==='verified'?'Request recorded. Provider notification is disabled; no message was sent.':
        row.state==='auth_required'||row.state==='conflict'||row.state==='permanent_failure'?`Needs review: ${row.lastErrorCode||row.state}. No notification was sent.`:'Saved on this device — pending synchronization. No notification was sent.');
    });});
  },[operation,principal]);
  const choices=context?[
    ...(context.frame?[{type:'frame',id:context.frame.id,label:'Frame'}]:[]),
    ...context.door_leaves.map((l:any)=>({type:'door_leaf',id:l.id,label:l.leaf_role==='single'?'Door leaf':l.leaf_role+' leaf'})),
    ...context.hardware_components.map((c:any)=>({type:'component',id:c.id,label:componentLabel(c,context)}))]:[];
  const targets=choices.filter(c=>selected.includes(c.type+':'+c.id));
  const allowedPhotos=context?.photos.filter((p:any)=>p.related_entity_type==='opening'||targets.some(t=>p.related_entity_type===(t.type==='component'?'hardware_component':t.type)&&p.related_entity_id===t.id))||[];
  const canSubmit=['admin','facilities_manager','technician','inspector'].includes(principal.role);
  const valid=canSubmit&&!!provider&&!!symptom.trim()&&(uncertain||targets.length>0)&&context?.status!=='decommissioned';
  async function save(){
    setSaving(true);setError('');
    try{
      await queueOpeningMutation('service_request',id!,{symptom:symptom.trim(),impact:impact.trim(),priority,provider_organization_id:provider,
        uncertain_target:uncertain,targets:uncertain?[]:targets.map(({type,id})=>({type,id})),photo_ids:photos.filter(p=>allowedPhotos.some((v:any)=>v.id===p))},operationId,principal);
      setOperation(operationId);setStatus('Saved on this device — pending synchronization. No notification was sent.');
    }catch(e){setError(isClientPrincipalChange(e)?'Account changed. Close this form and sign in again.':e instanceof Error?e.message:'Request could not be saved.');}
    finally{setSaving(false);}
  }
  async function startSeparateRequest(){
    setSaving(true);setError('');
    try{
      if(navigator.onLine)setContext(await fetchServiceRequestContext(id!,principal));
      setOperation('');setOperationId(crypto.randomUUID());setReview(false);setSelected([]);setUncertain(false);setPhotos([]);setProvider('');setSymptom('');setImpact('');setPriority('normal');
    }catch(e){setError(e instanceof Error?e.message:'Could not refresh assigned providers.');}
    finally{setSaving(false);}
  }
  return <div className="app-shell c04"><div className="top-bar"><h1>Request service</h1><SyncBadge/></div><div className="screen">
    <section className="c04-band-green"><Link to={`/opening/${id}`}>Opening record</Link>
    <p>A request records a problem for review. It does not record completed work, change condition, or authorize purchasing.</p>
    <p>Provider notifications are disabled in this release.</p></section>
    {!canSubmit&&<p>Your account can view requests but cannot submit them.</p>}
    {error&&<p className="c04-alert" role="alert">{error}</p>}
    {offline&&<p>Using previously loaded details. Access and provider assignment will be checked again when this request synchronizes.</p>}
    {operation?<><p role="status">{status}</p><Link to="/sync-issues">View synchronization issues</Link><p>Starting a separate request retains this request and its synchronization history.</p><button className="btn btn-secondary" disabled={saving||!canSubmit} onClick={startSeparateRequest}>Start a separate request</button></>:context&&<>
      <h2>{context.opening_code}</h2>
      {context.status==='decommissioned'?<p>This opening is retired. New requests are unavailable.</p>:<>
      {!review?<form className="c04-band-blue" onSubmit={e=>{e.preventDefault();if(valid)setReview(true);}}>
        <fieldset><legend>Which parts need service?</legend>
          <label><input type="checkbox" checked={uncertain} onChange={e=>{setUncertain(e.target.checked);setSelected([]);setPhotos([]);}}/> Unsure — opening-level review</label>
          {choices.map(c=><label key={c.type+c.id} style={{display:'block'}}><input type="checkbox" disabled={uncertain} checked={selected.includes(c.type+':'+c.id)} onChange={e=>{setSelected(v=>e.target.checked?[...v,c.type+':'+c.id]:v.filter(k=>k!==c.type+':'+c.id));setPhotos([]);}}/>{c.label}</label>)}
        </fieldset>
        <div className="field"><label htmlFor="request-symptom">Problem observed</label><textarea id="request-symptom" required maxLength={4000} value={symptom} onChange={e=>setSymptom(e.target.value)}/></div>
        <div className="field"><label htmlFor="request-impact">Operational impact</label><textarea id="request-impact" maxLength={2000} value={impact} onChange={e=>setImpact(e.target.value)}/></div>
        <div className="field"><label htmlFor="request-priority">Priority</label><select id="request-priority" value={priority} onChange={e=>setPriority(e.target.value)}>{['low','normal','high','urgent'].map(p=><option key={p}>{p}</option>)}</select></div>
        <div className="field"><label htmlFor="request-provider">Assigned service provider</label><select id="request-provider" required value={provider} onChange={e=>setProvider(e.target.value)}><option value="">Choose provider</option>{context.providers.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        {!context.providers.length&&<p>No provider is assigned. Contact the facility administrator before submitting a request.</p>}
        <fieldset><legend>Existing verified photographs</legend><p>Only photographs of this opening or the selected parts can be attached. Capture new photographs on the component record first.</p>
          {allowedPhotos.map((p:any)=><label key={p.id} style={{display:'block'}}><input type="checkbox" checked={photos.includes(p.id)} onChange={e=>setPhotos(v=>e.target.checked?[...v,p.id]:v.filter(k=>k!==p.id))}/>{p.related_entity_type==='opening'?'Opening':choices.find(c=>c.id===p.related_entity_id)?.label} — photo {p.id.slice(0,8)}</label>)}
          {!allowedPhotos.length&&<p>No verified photographs available for these targets.</p>}
        </fieldset><button className="btn btn-primary" disabled={!valid}>Review request</button>
      </form>:<section className="c04-band-green"><h3>Review before submitting</h3><p>{uncertain?'Opening-level review; component uncertain':targets.map(t=>t.label).join('; ')}</p><p>{symptom}</p><p>Impact: {impact||'Not supplied'}</p><p>Priority: {priority}</p><p>Provider: {context.providers.find((p:any)=>p.id===provider)?.name}</p><p>{photos.length} verified photograph(s)</p><button className="btn btn-secondary" disabled={saving} onClick={()=>setReview(false)}>Edit request</button><button className="btn btn-primary" disabled={saving||!valid} onClick={save}>{saving?'Saving…':'Submit request'}</button></section>}
      </>}
      <h3>Recorded requests</h3>{context.requests.length?context.requests.map((r:any)=><p key={r.id}>{r.symptom} — {r.status}; notification disabled</p>):<p>No recorded requests available.</p>}
    </>}
  </div></div>;
}
