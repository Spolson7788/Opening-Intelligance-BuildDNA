export function exactSum(values:Array<number|null>){
 let n=0n;for(const v of values){if(v===null)return null;if(!Number.isSafeInteger(v))throw Error('invalid_money');n+=BigInt(v);}
 if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('amount_out_of_range');return Number(n);
}
// Categories are independent stages, never additive spending. No accounting recognition is inferred.
export function reconcileCosts(records:any[]){
 const byId=new Map(records.map(r=>[r.id,r])),superseded=new Set(records.map(r=>r.correction_of).filter(Boolean));
 const root=(r:any):string=>{let current=r;const seen=new Set();while(current.correction_of&&byId.has(current.correction_of)&&!seen.has(current.id)){seen.add(current.id);current=byId.get(current.correction_of);}return current.id;};
 const current=records.filter(r=>!superseded.has(r.id));
 return current.filter(r=>r.kind==='invoice').map(invoice=>{
  const invoiceId=root(invoice),entries=current.filter(r=>r.invoice_id===invoiceId),credits=entries.filter(r=>r.kind==='credit'),payments=entries.filter(r=>r.kind==='payment');
  const gross=invoice.payload.amount_minor,credit=exactSum(credits.map(r=>r.payload.amount_minor)),paid=exactSum(payments.map(r=>r.payload.amount_minor));
  const net=gross===null||credit===null?null:exactSum([gross,-credit]),outstanding=net===null||paid===null?null:exactSum([net,-paid]);
  const exceptions:string[]=[];
  if([gross,credit,paid].includes(null))exceptions.push('unknown_amount');
  if([invoice,...entries].some(r=>r.payload.disputed))exceptions.push('disputed_evidence');
  if([invoice,...entries].some(r=>!r.payload.verified_document))exceptions.push('unverified_source');
  if(!invoice.payload.budget_version_id)exceptions.push('unmatched_budget');
  if(net!==null&&net<0)exceptions.push('credits_exceed_invoice');
  if(outstanding!==null&&outstanding<0)exceptions.push('payments_exceed_net_invoice');
  return {invoice_id:invoiceId,current_invoice_record_id:invoice.id,reference:invoice.payload.reference,currency:invoice.payload.currency,minor_unit_digits:invoice.payload.minor_unit_digits,recorded_gross_minor:gross,recorded_credit_minor:credit,recorded_net_invoice_minor:net,recorded_payment_evidence_minor:paid,recorded_unpaid_difference_minor:outstanding,recognized_actual_minor:null,committed_minor:null,exceptions,record_ids:[invoice.id,...entries.map(r=>r.id)],sandbox:true};
 });
}
