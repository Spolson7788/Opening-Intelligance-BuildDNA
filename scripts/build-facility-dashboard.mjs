import {readFileSync,writeFileSync,cpSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
export function buildFacilityDashboard(destination){
 const root=resolve(import.meta.dirname,'../facility-dashboard');
 let html=readFileSync(resolve(root,'portal-source.html'),'utf8');
 const replace=(a,b)=>{if(!html.includes(a))throw Error('Dashboard source changed: '+a.slice(0,80));html=html.replace(a,b);};
 replace('import {url,key} from "./preview-config.mjs";', 'import {sb,refreshScope,refreshFacility,readFieldSession} from "./api-client.mjs";');
 replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';",'');
 replace('const SUPA_URL=url;', '');replace('const SUPA_KEY=key;','');replace('const sb=createClient(SUPA_URL,SUPA_KEY);','');
 replace('if(!session){',`if(!session){document.getElementById('loginView').innerHTML='<h2>Facility Dashboard</h2><p>Sign in with your Field App account to view your company’s facilities.</p><a href="/field/scan">Sign in to Opening Intelligence</a>';`);
 replace("if(await routeByType(session))return;", "if(await routeByType(session))return;await refreshScope();");
 replace("const {data:ops,error}=await loadDashboardRows(sb,fac.id);", "await refreshFacility(fac.id);const {data:ops,error}=await loadDashboardRows(sb,fac.id);");
 replace("function openingScore(o){", "function openingScore(o){if(o.parts[0]&&'opening_health_score' in o.parts[0])return o.parts[0].opening_health_score;");
 replace("var complete=OPEN.every(o=>o.parts.every(p=>assessedScore(p)!==null));", "var complete=OPEN.every(o=>openingScore(o)!==null);");
 html=html.replaceAll('Opening review','Field App');
 html=html.replaceAll('href="opening.html"','href="/field/setup-opening"').replaceAll("href='/'", "href='/field/scan'").replaceAll('href="/"','href="/field/scan"');
 html=html.replace("parts=(ops||[]).length", "parts=(ops||[]).filter(p=>!p.placeholder).length").replaceAll("o.parts.length", "o.parts.filter(p=>!p.placeholder).length");
 // The canonical API has service history, not the preview-only deficiency workflow.
 html=html.replaceAll('Service &amp; compliance','Service history').replaceAll('Service & compliance','Service history');
 html=html.replace('Recorded from the field app. Deficiencies awaiting qualified verification are listed first — a completed repair does not close them.', 'Recorded service events from the connected Field App.');
 html=html.replaceAll('new Date(e.performed_at).toLocaleDateString()', "formatCalendarDate(String(e.performed_at).slice(0,10))");
 replace("_detailInit();boot();", `document.getElementById('recoverAccount').hidden=true;
 document.getElementById('recoverLogin').hidden=true;
 const refresh=document.createElement('button');refresh.textContent='Refresh saved records';refresh.onclick=()=>boot().catch(e=>{clearFacility();document.getElementById('facSub').textContent=e.message;});document.getElementById('facPickWrap').before(refresh);
 let displayedAccount=null;setInterval(async()=>{const a=await readFieldSession();const key=a?[a.userId,a.organizationId,a.token].join(':'):null;if(displayedAccount!==null&&displayedAccount!==key){clearFacility();location.reload();}displayedAccount=key;},1500);
 _detailInit();boot().catch(e=>{clearFacility();document.getElementById('facSub').textContent=e.message;});`);
 mkdirSync(destination,{recursive:true});writeFileSync(resolve(destination,'index.html'),html);
 for(const name of ['api-client.mjs','connected.mjs','facility-search.mjs'])cpSync(resolve(root,name),resolve(destination,name));
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename)buildFacilityDashboard(resolve(process.argv[2]||'dist/facility-dashboard'));
