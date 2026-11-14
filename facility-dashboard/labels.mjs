import { api, readFieldSession } from './api-client.mjs';
const element=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};

export async function showLabelPreview(openings) {
  document.getElementById('oi-label-dialog')?.close();
  const dialog=element('dialog');dialog.id='oi-label-dialog';
  dialog.style.cssText='max-width:760px;width:90%;padding:24px;color:#17212b;background:white;border:1px solid #82919f;border-radius:12px';
  const status=element('p','Checking readiness…');status.setAttribute('role','status');
  const list=element('div'),count=element('p','0 selected'),generate=element('button','Generate print file'),print=element('button','Print / Save PDF'),close=element('button','Close');
  const previewLabels=element('div');previewLabels.setAttribute('aria-label','Generated label preview');previewLabels.style.cssText='display:flex;flex-wrap:wrap;gap:16px;max-width:100%;overflow:auto';
  generate.disabled=true;print.hidden=true;close.onclick=()=>dialog.close();
  const format=element('select');format.setAttribute('aria-label','Label format');
  for(const [value,label] of [['letter-2in-v1','US Letter — 2 × 2 inch cut labels'],['single-2in-v1','Single 2 × 2 inch label']]){const option=element('option',label);option.value=value;format.append(option);}
  dialog.append(element('h2','Print / reprint opening labels'),element('p','Online verification required. Printing preserves the existing opening identity.'),element('p','Print at actual size (100%), with browser headers and footers off. Physical printer/phone acceptance is still required.'),format,list,count,previewLabels,status,generate,print,close);
  document.body.append(dialog);dialog.showModal();
  const initial=await readFieldSession(),selected=new Set();let operationId=crypto.randomUUID(),generated=null;
  const verify=async()=>{const current=await readFieldSession();if(!current||!initial||current.userId!==initial.userId||current.organizationId!==initial.organizationId)throw Error('Account changed. Close this preview and sign in again.');};
  const changed=()=>{operationId=crypto.randomUUID();generated=null;print.hidden=true;previewLabels.replaceChildren();document.getElementById('oi-label-print')?.remove();count.textContent=selected.size+' selected';generate.disabled=!selected.size||(format.value==='single-2in-v1'&&selected.size!==1);};
  format.onchange=changed;
  const guard=setInterval(async()=>{try{await verify();}catch{dialog.close();}},1000);
  dialog.addEventListener('close',()=>{clearInterval(guard);document.getElementById('oi-label-print')?.remove();document.getElementById('oi-label-style')?.remove();dialog.remove();},{once:true});
  try {
    if(!openings.length||openings.length>100)throw Error('Choose between 1 and 100 openings for a batch.');
    const preview=await api('/labels/preview?opening_ids='+openings.map(o=>encodeURIComponent(o.id)).join(','));
    if(!dialog.isConnected)return;
    for(const item of preview.items){
      const row=element('label'),check=element('input');row.style.cssText='display:block;padding:8px;border-bottom:1px solid #ddd';
      check.type='checkbox';check.disabled=!item.eligible;
      if(openings.length===1&&item.eligible){check.checked=true;selected.add(item.id);}
      check.onchange=()=>{check.checked?selected.add(item.id):selected.delete(item.id);changed();};
      row.append(check,document.createTextNode(` ${item.facility_name} / ${item.building_name} / ${item.opening_code} — ${item.eligible?'Ready':item.missing.join(', ').replaceAll('_',' ')}`));list.append(row);
    }
    changed();status.textContent='Select openings to print. Incomplete openings remain blocked.';
  }catch(e){status.textContent=e.message;}
  generate.onclick=async()=>{
    const submittedOperation=operationId,submittedTemplate=format.value,submittedIds=[...selected].sort();
    generate.disabled=true;print.hidden=true;
    try {
      await verify();
      const result=await api('/labels/generations',{opening_ids:submittedIds,operation_id:submittedOperation,template:submittedTemplate});
      if(!dialog.isConnected||submittedOperation!==operationId)return;
      generated=result;
      const sheet=element('section');sheet.id='oi-label-print';
      for(const item of generated.items){const card=element('article');card.className='oi-print-card';const img=element('img');img.src=item.qr_data_url;img.alt='QR for '+item.opening_code;card.append(element('small',item.facility_name+' / '+item.building_name),img,element('strong',item.opening_code));sheet.append(card);}
      document.getElementById('oi-label-print')?.remove();document.body.append(sheet);
      document.getElementById('oi-label-style')?.remove();const style=element('style');style.id='oi-label-style';
      const single=generated.template==='single-2in-v1';
      style.textContent=`#oi-label-print{display:none}.oi-print-card{box-sizing:border-box;width:2in;height:2in;padding:.08in;text-align:center;color:#000;background:#fff;break-inside:avoid;display:flex;flex-direction:column;align-items:center;justify-content:center}.oi-print-card img{width:1.35in;height:1.35in}.oi-print-card small{font:8px Arial;overflow-wrap:anywhere}.oi-print-card strong{font:bold 10px Arial;overflow-wrap:anywhere;max-width:100%}@media print{@page{size:${single?'2in 2in':'letter'};margin:${single?'0':'.5in'}}body>*{display:none!important}body>#oi-label-print{display:grid!important;grid-template-columns:repeat(${single?1:3},2in);gap:.15in}body{margin:0!important;background:white!important}dialog::backdrop{display:none}}`;
      document.head.append(style);
      previewLabels.replaceChildren(...[...sheet.children].map(card=>card.cloneNode(true)));
      await Promise.all([...sheet.querySelectorAll('img')].map(img=>img.decode()));await verify();
      if(!dialog.isConnected||submittedOperation!==operationId)return;
      print.hidden=false;status.textContent=`Print file generated for ${generated.count} opening(s). Printing or affixing a label is not confirmed.`;
    }catch(e){if(submittedOperation===operationId)status.textContent=e.message;}finally{generate.disabled=!selected.size||(format.value==='single-2in-v1'&&selected.size!==1);}
  };
  print.onclick=async()=>{try{await verify();if(generated)window.print();}catch(e){print.hidden=true;status.textContent=e.message;}};
}

export function installLabelActions({getOpenings,toolbar}) {
  const button=element('button','Print selected QR labels');button.className='tool';button.onclick=()=>showLabelPreview(getOpenings());toolbar.append(button);
}
export function addOpeningLabelAction(container,opening) {
  const button=element('button','Print / reprint QR label');button.className='tool';button.onclick=()=>showLabelPreview([opening]);container.append(button);
}
