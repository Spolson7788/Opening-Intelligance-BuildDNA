import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { listFieldPortfolios, listFieldProperties, createFieldProperty, createFieldBuilding, createFieldOpening, searchFieldFacilities } from "../lib/api";
interface Building { id:string; name:string }
interface Facility { id:string; name:string; buildings:Building[]; state?:string; city?:string; address_line1?:string; postal_code?:string; service_territory?:string }
interface Portfolio { id:string; name:string }
export function SetupOpeningPage() {
  const {auth}=useAuth(); const navigate=useNavigate();
  const [portfolios,setPortfolios]=useState<Portfolio[]>([]); const [facilities,setFacilities]=useState<Facility[]>([]);
  const [state,setState]=useState(""); const [territory,setTerritory]=useState(""); const [query,setQuery]=useState("");
  const [portfolio,setPortfolio]=useState(""); const [facility,setFacility]=useState(""); const [building,setBuilding]=useState("");
  const [facilityName,setFacilityName]=useState(""); const [buildingName,setBuildingName]=useState(""); const [code,setCode]=useState("");
  const [type,setType]=useState("healthcare"); const [configuration,setConfiguration]=useState("single"); const [fire,setFire]=useState(false);
  const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [notice,setNotice]=useState("");
  const canCreate=!!auth && ["admin","facilities_manager","technician"].includes(auth.role);
  useEffect(()=>{let current=true;setFacilities([]);setPortfolios([]);setState("");setTerritory("");setFacility("");setBuilding("");setPortfolio("");setQuery("");if(!auth)return;Promise.all([listFieldPortfolios(),listFieldProperties(),searchFieldFacilities()]).then(([p,f,scope])=>{
    if(!current)return;setState(scope.preferences.home_state||"");setTerritory(scope.preferences.home_territory||"");
    setPortfolios(p);setFacilities(f); if(p.length===1)setPortfolio(p[0].id);
  }).catch(()=>{if(current)setError("Connect to load your organization's facilities.");});return ()=>{current=false;};},[auth?.userId,auth?.organizationId]);
  const visible=facilities.filter(f=>(!state||f.state?.trim().toUpperCase()===state)&&(!territory||f.service_territory===territory)&&(!query.trim()||[f.name,f.city,f.address_line1,f.postal_code].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase())));
  function resetSelection(){setFacility("");setBuilding("");}
  const buildings=facilities.find(f=>f.id===facility)?.buildings??[];
  async function perform(action:()=>Promise<void>) {
    if(busy)return; if(!navigator.onLine){setError("Facility and opening setup requires a connection. Nothing was submitted.");return;}
    setBusy(true);setError("");setNotice("");
    try {await action();} catch {setError("Could not confirm the save. Reload the facility list before retrying to check whether it was saved.");} finally{setBusy(false);}
  }
  return <div className="screen"><Link to="/scan">Back to openings</Link><h1>Facilities and openings</h1>{auth?.role==="admin"&&<Link to="/branches">Manage company branches</Link>}
    <p>Connected setup for your organization. Hardware, specifications and photographs can be queued once an opening is available on this device.</p>
    {error&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <div className="field"><label htmlFor="territory">My Territory</label><select id="territory" value={territory} onChange={e=>{setTerritory(e.target.value);resetSelection();}}><option value="">All authorized territories</option>{[...new Set([...facilities.map(f=>f.service_territory),territory].filter((v):v is string=>!!v))].sort().map(v=><option key={v}>{v}</option>)}</select></div>
    <div className="field"><label htmlFor="state">State</label><select id="state" value={state} onChange={e=>{setState(e.target.value);resetSelection();}}><option value="">All authorized states</option>{[...new Set([...facilities.map(f=>f.state?.trim().toUpperCase()),state].filter((v):v is string=>!!v))].sort().map(v=><option key={v}>{v}</option>)}</select></div>
    <div className="field"><label htmlFor="facility-query">Find facility</label><input id="facility-query" type="search" placeholder="Name, address, city or ZIP" value={query} onChange={e=>{setQuery(e.target.value);resetSelection();}}/></div>
    <p role="status">{visible.length} authorized facilities match.</p>
    <div className="field"><label htmlFor="facility">Facility</label><select id="facility" value={facility} onChange={e=>{setFacility(e.target.value);setBuilding("");}}><option value="">Select facility…</option>{visible.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
    {!facilities.length&&<p>No facilities are available yet.</p>}
    <div className="field"><label htmlFor="building">Building</label><select id="building" disabled={!facility} value={building} onChange={e=>setBuilding(e.target.value)}><option value="">Select building…</option>{buildings.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
    {canCreate&&<>
    <form onSubmit={e=>{e.preventDefault();void perform(async()=>{const row=await createFieldProperty({portfolio_id:portfolio,name:facilityName.trim(),property_type:type});setFacilities(prev=>[...prev,{...row,buildings:[]}]);setState("");setTerritory("");setQuery("");setFacility(row.id);setBuilding("");setFacilityName("");setNotice("Facility saved.");});}}>
      <h2>Add facility</h2><div className="field"><label htmlFor="portfolio">Portfolio</label><select id="portfolio" required value={portfolio} onChange={e=>setPortfolio(e.target.value)}><option value="">Select portfolio…</option>{portfolios.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div className="field"><label htmlFor="facility-name">Facility name</label><input id="facility-name" required value={facilityName} onChange={e=>setFacilityName(e.target.value)}/></div>
      <div className="field"><label htmlFor="facility-type">Facility type</label><select id="facility-type" value={type} onChange={e=>setType(e.target.value)}>{[["multifamily","Multifamily"],["senior_living","Senior living"],["healthcare","Healthcare"],["university","University"],["hospitality","Hospitality"],["other","Other"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
      <button className="btn btn-secondary" disabled={busy||!portfolio||!facilityName.trim()}>Save facility</button>
    </form>
    <form onSubmit={e=>{e.preventDefault();void perform(async()=>{const b=await createFieldBuilding({property_id:facility,name:buildingName.trim()});setFacilities(prev=>prev.map(f=>f.id===facility?{...f,buildings:[...f.buildings,b]}:f));setBuilding(b.id);setBuildingName("");setNotice("Building saved.");});}}>
      <h2>Add building to selected facility</h2><div className="field"><label htmlFor="building-name">Building name</label><input id="building-name" required value={buildingName} onChange={e=>setBuildingName(e.target.value)}/></div><button className="btn btn-secondary" disabled={busy||!facility||!buildingName.trim()}>Save building</button>
    </form>
    <form onSubmit={e=>{e.preventDefault();void perform(async()=>{const row=await createFieldOpening({building_id:building,opening_code:code.trim(),opening_type:"door",opening_configuration:configuration,fire_rated:fire});navigate(`/opening/${row.id}`);});}}>
      <h2>Add door opening</h2><div className="field"><label htmlFor="opening-code">Opening code</label><input id="opening-code" required value={code} onChange={e=>setCode(e.target.value)}/></div>
      <div className="field"><label htmlFor="configuration">Door configuration</label><select id="configuration" value={configuration} onChange={e=>setConfiguration(e.target.value)}><option value="single">Single door</option><option value="pair">Paired doors</option></select></div>
      <label><input type="checkbox" checked={fire} onChange={e=>setFire(e.target.checked)}/> This is a fire-rated opening</label><p>Set the classification only from the opening's documented evidence.</p>
      <button className="btn btn-primary" disabled={busy||!building||!code.trim()}>Create opening</button>
    </form></>}
  </div>;
}
