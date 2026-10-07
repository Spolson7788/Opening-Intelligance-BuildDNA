import {api} from './api-client.mjs';
// All source content is inserted as text, never interpreted as HTML.
export async function mountReferenceEvidence(container,openingId){
 const title=document.createElement('h3');title.textContent='Saved recognition evidence';container.replaceChildren(title);
 try{
  const data=await api('/recognition/opening/'+encodeURIComponent(openingId));
  if(!container.isConnected)return;
  if(!data.runs.length){const p=document.createElement('p');p.textContent='No recognition runs recorded for this opening.';container.append(p);}
  for(const run of data.runs){
   const details=document.createElement('details'),summary=document.createElement('summary');
   summary.textContent=(run.component_id?'Component '+run.component_id:'Opening recognition')+' — '+(run.suggestion?.manufacturer||'Unknown')+' '+(run.suggestion?.model||'');details.append(summary);
   const status=document.createElement('p');status.textContent=run.status==='reference_evidence'?'Manufacturer reference evidence — technician review required':'No reference evidence — preliminary photograph analysis only';details.append(status);
   const candidates=Array.isArray(run.stage_two?.candidates)?run.stage_two.candidates.filter(c=>c&&typeof c==='object').slice(0,3):[];
   if(candidates.length){const heading=document.createElement('h4'),note=document.createElement('p'),list=document.createElement('ul');heading.textContent='Possible products in the compared reference set';note.textContent='These are possibilities, not confirmed identities. Other products may also fit.';
    for(const candidate of candidates){const item=document.createElement('li'),name=document.createElement('strong');name.textContent=[candidate.manufacturer,candidate.model||candidate.series].filter(Boolean).join(' ')||'Unspecified candidate';item.append(name);
     for(const feature of Array.isArray(candidate.supporting_features)?candidate.supporting_features:[]){const p=document.createElement('p');p.textContent=(feature?.citation?'Consistent observation: ':'Visual hypothesis without a supporting source citation: ')+String(feature?.observation||'');item.append(p);}
     for(const feature of Array.isArray(candidate.contradicting_features)?candidate.contradicting_features:[]){const p=document.createElement('p');p.textContent='Possible difference: '+String(feature?.observation||'');item.append(p);}list.append(item);
    }details.append(heading,note,list);
   }
   if(run.stage_two?.cover_comparison==='unavailable_without_installed_cover'){const p=document.createElement('p');p.textContent='The cover is removed or not visible. Cover style cannot be compared and does not rule out these products.';details.append(p);}
   for(const c of run.citations||[]){
    const button=document.createElement('button'),quote=document.createElement('blockquote');button.type='button';button.textContent='Open supporting page '+c.page_no;quote.textContent=c.quote;details.append(button,quote);
    button.onclick=async()=>{button.disabled=true;const view=document.createElement('section');details.append(view);try{
     const {page}=await api('/references/'+encodeURIComponent(c.doc_sha256)+'/pages/'+c.page_no);
     if(!container.isConnected)return;const label=document.createElement('p');label.textContent=page.brand+' — '+page.title+' — page '+page.page_no;view.append(label);
     if(page.pdf_url){const link=document.createElement('a');link.href=page.pdf_url+'#page='+page.page_no;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open original manufacturer PDF';view.append(link);}
     if(page.image_url){const img=document.createElement('img');img.src=page.image_url;img.alt='Reference page '+page.page_no;img.style.maxWidth='100%';view.append(img);}
     const text=document.createElement('pre');text.textContent=page.text;text.style.whiteSpace='pre-wrap';view.append(text);
    }catch{view.textContent='Reference unavailable. It may have been withdrawn or superseded.';}finally{button.disabled=false;}};
   }
   for(const conflict of run.conflicts||[]){const p=document.createElement('p');p.textContent='Unresolved specification: '+conflict.field+' — '+(conflict.values||[]).map(v=>v.value+' (page '+v.page+')').join(' / ');details.append(p);}
   for(const value of run.stage_two?.unresolved||[]){const p=document.createElement('p');p.textContent=String(value);details.append(p);}
   container.append(details);
  }
 }catch{if(container.isConnected){const p=document.createElement('p');p.textContent='Recognition evidence history unavailable. Refresh to retry.';container.append(p);}}
}
