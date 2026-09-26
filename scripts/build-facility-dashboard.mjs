import {readFileSync,writeFileSync,cpSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
export function buildFacilityDashboard(destination){
 const root=resolve(import.meta.dirname,'../facility-dashboard');
 let html=readFileSync(resolve(root,'portal-source.html'),'utf8');
 const replace=(a,b)=>{if(!html.includes(a))throw Error('Dashboard source changed: '+a.slice(0,80));html=html.replace(a,b);};
 replace('import {url,key} from "./preview-config.mjs";', 'import {sb,refreshScope,refreshFacility,readFieldSession,api} from "./api-client.mjs";');
 replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';",'');
 replace('const SUPA_URL=url;', '');replace('const SUPA_KEY=key;','');replace('const sb=createClient(SUPA_URL,SUPA_KEY);','');
 replace('if(!session){',`if(!session){document.getElementById('loginView').innerHTML='<h2>Facility Dashboard</h2><p>Sign in with your Field App account to view your company’s facilities.</p><a href="/field/scan">Sign in to Opening Intelligence</a>';`);
 replace("if(await routeByType(session))return;", "if(await routeByType(session))return;await refreshScope();");
 replace("const {data:ops,error}=await loadDashboardRows(sb,fac.id);", "await refreshFacility(fac.id);const {data:ops,error}=await loadDashboardRows(sb,fac.id);");
 replace("function openingScore(o){", "function openingScore(o){if(o.parts[0]&&'opening_health_score' in o.parts[0])return o.parts[0].opening_health_score;");
 replace("var complete=OPEN.every(o=>o.parts.every(p=>assessedScore(p)!==null));", "var complete=OPEN.every(o=>openingScore(o)!==null);");
 html=html.replaceAll('Opening review','Field App');
 html=html.replace('build v53','connected staging');
 html=html.replaceAll('href="opening.html"','href="/field/setup-opening"').replaceAll("href='/'", "href='/field/scan'").replaceAll('href="/"','href="/field/scan"');
 html=html.replace("parts=(ops||[]).length", "parts=(ops||[]).filter(p=>!p.placeholder).length").replaceAll("o.parts.length", "o.parts.filter(p=>!p.placeholder).length");
 // The canonical API has service history, not the preview-only deficiency workflow.
 html=html.replaceAll('Service &amp; compliance','Service history').replaceAll('Service & compliance','Service history');
 html=html.replace('Recorded from the field app. Deficiencies awaiting qualified verification are listed first — a completed repair does not close them.', 'Recorded service events from the connected Field App.');
 html=html.replaceAll('new Date(e.performed_at).toLocaleDateString()', "formatCalendarDate(String(e.performed_at).slice(0,10))");
 replace("function clearFacility(){", "function clearFacility(){document.getElementById('purchaseResult')?.replaceChildren();");
 replace("_detailInit();boot();", `document.getElementById('recoverAccount').hidden=true;
 document.getElementById('recoverLogin').hidden=true;
 const refresh=document.createElement('button');refresh.textContent='Refresh saved records';refresh.onclick=()=> (current?load(current):boot()).catch(e=>{clearFacility();document.getElementById('facSub').textContent=e.message;});document.getElementById('facPickWrap').before(refresh);
 const purchase=document.createElement('button');purchase.textContent='Review purchasing';
 const result=document.createElement('section');result.id='purchaseResult';result.setAttribute('aria-live','polite');
 document.getElementById('facPickWrap').before(purchase);document.getElementById('facPickWrap').after(result);
 purchase.onclick=async()=>{result.replaceChildren();const stamp=facilityEpoch,ids=[...new Set(VIEW.map(o=>o.parts[0]?.assembly_id).filter(Boolean))];
 if(!ids.length){result.textContent='No openings selected.';return;}purchase.disabled=true;
 try{const review=await api('/purchasing/review',{opening_ids:ids});if(stamp!==facilityEpoch)return;
 const title=document.createElement('h2');title.textContent=review.blocked?'Purchasing review: requirements unresolved':review.status==='no_replacements'?'No replacements required':'Purchasing review: eligible replacements';result.append(title);
 const notice=document.createElement('p');notice.textContent='Review only — nothing is sent or ordered.';result.append(notice);
 for(const o of review.openings.filter(o=>!o.opening_complete)){const p=document.createElement('p');const label=VIEW.find(v=>v.parts[0]?.assembly_id===o.opening_id)?.opening_no||o.opening_id;p.textContent=label+': complete, assess and review the entire opening first.';result.append(p);}
 for(const d of review.decisions){const p=document.createElement('p');const part=VIEW.flatMap(o=>o.parts).find(p=>p.id===d.component_id);p.textContent=(part?.opening_no||d.opening_id)+' · '+(part?.component_class||d.component_id)+': '+(d.eligible?(review.blocked?'Eligible item held because another requirement is unresolved':'Eligible') : d.reasons.map(r=>({condition_unverified:'Condition not verified',replacement_not_required:'Excluded — replacement not required',opening_not_complete:'Opening incomplete',component_not_reviewed:'Component not reviewed',identity_unresolved:'Replacement identity unresolved',approved_document_required:'Approved supporting document required'}[r]||r)).join('; '));result.append(p);}
 }catch(e){if(stamp===facilityEpoch)result.textContent=e.message;}finally{purchase.disabled=false;}};
 let displayedAccount=null;setInterval(async()=>{const a=await readFieldSession();const key=a?[a.userId,a.organizationId,a.token].join(':'):null;if(displayedAccount!==null&&displayedAccount!==key){clearFacility();location.reload();}displayedAccount=key;},1500);
 _detailInit();boot().catch(e=>{clearFacility();document.getElementById('facSub').textContent=e.message;});`);
 mkdirSync(destination,{recursive:true});writeFileSync(resolve(destination,'index.html'),html);
 for(const name of ['api-client.mjs','connected.mjs','facility-search.mjs'])cpSync(resolve(root,name),resolve(destination,name));
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename)buildFacilityDashboard(resolve(process.argv[2]||'dist/facility-dashboard'));
