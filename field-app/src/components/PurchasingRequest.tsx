import {useEffect,useState} from 'react';
import {confirmPurchasingEmailSent,fetchPurchasingRequests,preparePurchasingRequest} from '../lib/api';
import {getSyncOperationsForOpening} from '../lib/db';
const acknowledgment='I reviewed the product selection and supporting information and confirm this request is ready for purchasing department review.';
export function PurchasingRequest({openingId}:{openingId:string}){
 const [recipient,setRecipient]=useState(''),[ack,setAck]=useState(false),[sent,setSent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [requestId,setRequestId]=useState(()=>crypto.randomUUID()),[record,setRecord]=useState<any>(null);
 useEffect(()=>{let active=true;fetchPurchasingRequests(openingId).then(r=>{if(active&&r.requests?.[0]){setRecord(r.requests[0]);setRecipient(r.requests[0].recipient_email);setRequestId(r.requests[0].request_id);}}).catch(()=>{});return()=>{active=false;};},[openingId]);
 function fail(e:unknown){const code=e instanceof Error?e.message:'';setError(code==='request_not_ready'?'Complete the opening and verify the manufacturer, model, condition, and review for every replacement first.':code==='request_changed_prepare_again'?'The product selection changed. Prepare a new request before sending.':code==='insufficient_role_for_action'||code==='forbidden'?'Your account cannot submit purchasing requests.':'The request could not be saved. Check your connection and try again.');}
 async function ensureSynced(){const operations=await getSyncOperationsForOpening(openingId);if(operations.some(o=>!['verified','synced'].includes(o.state)))throw Error('opening_changes_pending_sync');}
 async function prepare(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await ensureSynced();setRecord(await preparePurchasingRequest({request_id:requestId,opening_id:openingId,recipient_email:recipient.trim(),acknowledged:true}));}catch(e){if(e instanceof Error&&e.message==='opening_changes_pending_sync')setError('Sync all opening changes and photographs before preparing the request.');else fail(e);}finally{setBusy(false);}}
 async function confirm(){setBusy(true);setError('');try{await ensureSynced();const result=await confirmPurchasingEmailSent(record.request_id);setRecord({...record,...result});}catch(e){if(e instanceof Error&&e.message==='opening_changes_pending_sync')setError('Sync the opening changes, then prepare a fresh request if the selection changed.');else fail(e);}finally{setBusy(false);}}
 const email=record?.email,mailto=email?`mailto:${encodeURIComponent(email.recipient)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`:'';
 return <section className="card" aria-label="Purchasing department request">
  <h2>Request purchasing review</h2><p>Send a product request to your service provider’s purchasing department. They verify the selection and authorize any purchase.</p>
  {error&&<p role="alert">{error}</p>}
  {!record?<form onSubmit={prepare}>
   <label>Purchasing department email<input type="email" required maxLength={254} value={recipient} disabled={busy} onChange={e=>setRecipient(e.target.value)}/></label>
   <label style={{display:'flex',gap:8}}><input type="checkbox" required checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/>{acknowledgment}</label>
   <button type="submit" disabled={!ack||busy}>{busy?'Preparing…':'Prepare purchasing email'}</button>
  </form>:<>
   <p role="status">{record.email_sent?'Submitted for purchasing review — email sending confirmed by technician.':'Prepared for purchasing review — email has not been marked sent.'}</p>
   <p>Recipient: {record.recipient_email}</p>
   {email&&<><label>Email draft<textarea readOnly value={email.body} rows={9}/></label><p>Attach the relevant photographs before sending from your email application.</p><a className="btn btn-secondary" href={mailto}>Open email draft</a></>}
   {!record.email_sent&&<><label style={{display:'flex',gap:8}}><input type="checkbox" checked={sent} disabled={busy} onChange={e=>setSent(e.target.checked)}/>I sent this email to the purchasing department.</label><button type="button" disabled={!sent||busy} onClick={confirm}>Record email as sent</button></>}
   <p>This request does not authorize a purchase or place an order.</p>
   <button type="button" disabled={busy} onClick={()=>{setRecord(null);setRequestId(crypto.randomUUID());setAck(false);setSent(false);setError('');}}>Prepare a new request</button>
  </>}
 </section>;
}
