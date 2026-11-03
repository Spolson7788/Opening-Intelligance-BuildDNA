import { useEffect, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import {
  addBranchArea, addTechnicianArea, assignProvider, fetchCoverage, listCounties, listStates, saveFacilityCounty,
} from "../lib/api";

type County = { fips: string; name: string };

export function CoveragePage() {
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [counties, setCounties] = useState<County[]>([]);
  const [coverage, setCoverage] = useState<Awaited<ReturnType<typeof fetchCoverage>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stateCode, setStateCode] = useState("");
  const [countyFips, setCountyFips] = useState("");
  const [facilityId, setFacilityId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [techId, setTechId] = useState("");
  const [providerId, setProviderId] = useState("");

  function load() {
    setError(null);
    return fetchCoverage().then(setCoverage).catch(() => setError("Couldn't load state and county coverage."));
  }
  useEffect(() => { listStates().then(setStates).catch(() => setError("Couldn't load states.")); load(); }, []);
  useEffect(() => {
    if (!stateCode) { setCounties([]); setCountyFips(""); return; }
    listCounties(stateCode).then(setCounties).catch(() => setCounties([]));
  }, [stateCode]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setError(null); setNotice(null);
    try { await action(); setNotice(ok); await load(); }
    catch (err: unknown) {
      const message = err && typeof err === "object" && "message" in err ? String((err as { message: string }).message) : "request_failed";
      setError(message === "out_of_area" ? "That provider does not cover this facility's state and county." : message === "county_not_in_state" ? "That county is not in the selected state." : "Couldn't save that change.");
    }
  }

  const facilities = coverage?.facilities ?? [];
  const grouped = new Map<string, typeof facilities>();
  for (const facility of facilities) {
    const key = `${facility.state_name ?? "State not set"} / ${facility.county_name ?? "County not set"}`;
    grouped.set(key, [...(grouped.get(key) ?? []), facility]);
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <div className="page-header"><div><h1>State and county</h1><p>Facility grouping, branch coverage, and technician areas.</p></div></div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}

        <div className="panel">
          <h2>Facilities</h2>
          {[...grouped.entries()].map(([label, rows]) => (
            <section key={label}>
              <h3>{label}</h3>
              <ul>{rows.map((facility) => <li key={facility.id}>{facility.name}{facility.city ? `, ${facility.city}` : ""}</li>)}</ul>
            </section>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void run(() => saveFacilityCounty(facilityId, stateCode || null, countyFips || null), "Facility location saved."); }}>
            <label>Facility <select aria-label="Facility" value={facilityId} onChange={(e) => setFacilityId(e.target.value)}><option value="">Choose a facility</option>{facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
            <label> State <select aria-label="Facility state" value={stateCode} onChange={(e) => setStateCode(e.target.value)}><option value="">State not set</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
            <label> County <select aria-label="Facility county" value={countyFips} onChange={(e) => setCountyFips(e.target.value)}><option value="">County not set</option>{counties.map((c) => <option key={c.fips} value={c.fips}>{c.name}</option>)}</select></label>
            <button className="btn btn-primary" type="submit" disabled={!facilityId}>Save facility</button>
          </form>
        </div>

        <div className="panel">
          <h2>Branch coverage</h2>
          {(coverage?.branches ?? []).map((branch) => (
            <p key={branch.id}><strong>{branch.name}</strong> — {branch.areas.length ? branch.areas.map((area) => area.county_name ? `${area.county_name}, ${area.state_name}` : area.state_name).join("; ") : "No state or county yet"}</p>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void run(() => addBranchArea(branchId, stateCode, countyFips || null), "Branch area saved."); }}>
            <label>Branch <select aria-label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Choose a branch</option>{(coverage?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <button className="btn btn-primary" type="submit" disabled={!branchId || !stateCode}>Add to branch</button>
          </form>
          <p>Leave county unset to cover the whole state. Uses the state and county selected above.</p>
        </div>

        <div className="panel">
          <h2>Technician areas</h2>
          <p>When a technician has an area, it replaces their branch area. Otherwise they use the branch.</p>
          {(coverage?.technicians ?? []).map((tech) => (
            <p key={tech.id}><strong>{tech.full_name}</strong> — {tech.areas.length ? tech.areas.map((area) => area.county_name ? `${area.county_name}, ${area.state_name}` : area.state_name).join("; ") : "Uses branch area"}</p>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void run(() => addTechnicianArea(techId, stateCode, countyFips || null), "Technician area saved."); }}>
            <label>Technician <select aria-label="Technician" value={techId} onChange={(e) => setTechId(e.target.value)}><option value="">Choose a technician</option>{(coverage?.technicians ?? []).map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}</select></label>
            <button className="btn btn-primary" type="submit" disabled={!techId || !stateCode}>Add technician area</button>
          </form>
        </div>

        <div className="panel">
          <h2>Facility assignments</h2>
          <ul>{(coverage?.assignments ?? []).map((row) => <li key={row.property_id + row.provider_organization_id}>{row.property_name} ({row.state_name ?? "state not set"} / {row.county_name ?? "county not set"}) — {row.provider_name}</li>)}</ul>
          <form onSubmit={(e) => { e.preventDefault(); void run(() => assignProvider(facilityId, providerId, true), "Provider assigned."); }}>
            <label>Provider company id <input aria-label="Provider company id" value={providerId} onChange={(e) => setProviderId(e.target.value)} /></label>
            <button className="btn btn-primary" type="submit" disabled={!facilityId || !providerId}>Assign provider</button>
          </form>
        </div>
      </div>
    </div>
  );
}
