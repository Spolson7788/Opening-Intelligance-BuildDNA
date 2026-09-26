import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {useAuth} from '../lib/AuthContext';
import {listBranches,saveBranch,assignBranch} from '../lib/api';
export function BranchesPage(){
 const {auth}=useAuth();const [data,setData]=useState<any>({branches:[],users:[]});const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const [id,setId]=useState('');const [name,setName]=useState('');const [state,setState]=useState('');const [territory,setTerritory]=useState('');const [active,setActive]=useState(true);
 useEffect(()=>{let current=true;setData({branches:[],users:[]});if(auth?.role==='admin')listBranches().then(d=>{if(current)setData(d);}).catch(()=>{if(current)setError('Unable to load branches.');});return()=>{current=false;};},[auth?.userId,auth?.organizationId]);
 async function perform(action:()=>Promise<any>){setBusy(true);setError('');setNotice('');try{await action();setData(await listBranches());setNotice('Saved. Branch defaults apply when the facility selector is opened again.');}catch{setError('Save not confirmed. Reload before retrying.');}finally{setBusy(false);}}
 if(auth?.role!=='admin')return <div className="screen"><Link to="/setup-opening">Back</Link><p>Company administrator access required.</p></div>;
 return <div className="screen"><Link to="/setup-opening">Back to facilities</Link><h1>Company branches</h1><p>Branch defaults narrow facility search. They do not grant access to facilities.</p>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 <div className="field"><label htmlFor="edit-branch">Edit branch</label><select id="edit-branch" value={id} onChange={e=>{const b=data.branches.find((b:any)=>b.id===e.target.value);setId(b?.id||'');setName(b?.name||'');setState(b?.default_state||'');setTerritory(b?.default_territory||'');setActive(b?.is_active??true);}}><option value="">New branch</option>{data.branches.map((b:any)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
 <form onSubmit={e=>{e.preventDefault();const branchId=id||crypto.randomUUID();void perform(async()=>{const result=await saveBranch(branchId,{name,default_state:state,default_territory:territory.trim()||null,is_active:active});setId(result.id);});}}>
 <div className="field"><label htmlFor="branch-name">Branch name</label><input id="branch-name" required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></div>
 <div className="field"><label htmlFor="branch-state">Default state</label><input id="branch-state" required pattern="[A-Z]{2}" maxLength={2} placeholder="CA" value={state} onChange={e=>setState(e.target.value.toUpperCase())}/></div>
 <div className="field"><label htmlFor="branch-territory">Default territory</label><input id="branch-territory" maxLength={120} value={territory} onChange={e=>setTerritory(e.target.value)}/></div>
 <label><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>Active branch</label><button className="btn btn-primary" disabled={busy}>Save branch</button></form>
 <h2>Team branch assignments</h2>{data.users.filter((u:any)=>u.is_active).map((u:any)=><div className="field" key={u.id}><label htmlFor={'user-'+u.id}>{u.full_name} — {u.email} ({u.role})</label><select id={'user-'+u.id} disabled={busy} value={u.branch_id||''} onChange={e=>{const branchId=e.target.value;void perform(()=>assignBranch(u.id,branchId||null));}}><option value="">No branch assignment</option>{data.branches.filter((b:any)=>b.is_active||b.id===u.branch_id).map((b:any)=><option key={b.id} value={b.id} disabled={!b.is_active}>{b.name}{b.is_active?'':' (inactive)'}</option>)}</select></div>)}
 </div>;
}
