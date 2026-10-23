// Reuse Field's canonical authenticated wizard and durable queue inside the Dashboard.
// No separate database or notification transport is introduced here.
import {readFieldSession} from './api-client.mjs';
export function addServiceRequestAction(container,opening){
  const commercial=document.createElement('a');commercial.textContent='Catalog and replacement estimates';commercial.href='/facility-dashboard/commercial.html?opening='+encodeURIComponent(opening.id);container.prepend(commercial);

  const history=document.createElement('a');history.textContent='Installation and service history';history.href='/field/opening/'+encodeURIComponent(opening.id)+'/lifecycle';container.prepend(history);
  const button=document.createElement('button');button.textContent='Request service';
  button.onclick=async()=>{
    document.getElementById('oi-request-dialog')?.close();
    const principal=await readFieldSession();if(!principal)return;
    const dialog=document.createElement('dialog');dialog.id='oi-request-dialog';dialog.style.cssText='width:95%;max-width:900px;height:90vh;padding:12px';
    const close=document.createElement('button');close.textContent='Close request';close.onclick=()=>dialog.close();
    const frame=document.createElement('iframe');frame.title='Opening service request';frame.src='/field/opening/'+encodeURIComponent(opening.id)+'/request-service';frame.style.cssText='display:block;width:100%;height:90%;border:0';
    dialog.append(close,frame);document.body.append(dialog);dialog.showModal();
    const timer=setInterval(async()=>{const current=await readFieldSession();if(!current||current.userId!==principal.userId||current.organizationId!==principal.organizationId)dialog.close();},1000);
    dialog.addEventListener('close',()=>{clearInterval(timer);dialog.remove();},{once:true});
  };container.prepend(button);
}
