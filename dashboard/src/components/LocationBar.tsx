import { useEffect, useState } from "react";
import { listCompanies, switchCompany } from "../lib/api";
import type { CompanyChoice } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { useLocations } from "../lib/LocationContext";
import { showCompanySwitcher, uniqueCompanies } from "../lib/locationScope";
import type { LocationFilter } from "../lib/locationScope";

const sel = { width: "100%", marginTop: 4, fontSize: 12, padding: 4 } as const;

/** M3 header controls: company switcher (only with 2+ companies) and the combined-view location filter. */
export function LocationBar() {
  const { auth, adoptToken } = useAuth();
  const { index, filter, setFilter } = useLocations();
  const [companies, setCompanies] = useState<CompanyChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (auth) listCompanies().then(setCompanies).catch(() => setCompanies([])); }, [auth?.userId, auth?.organizationId]);

  async function onSwitch(id: string) {
    setError(null);
    try { const r = await switchCompany(id); setFilter({ kind: "company" }); adoptToken(r.token); }
    catch { setError("Could not switch company."); }
  }
  const value = filter.kind === "branch" ? "b:" + filter.orgId : filter.kind === "facility" ? "f:" + filter.propertyId : filter.kind;
  function onFilter(v: string) {
    const f: LocationFilter = v.startsWith("b:") ? { kind: "branch", orgId: v.slice(2) } : v.startsWith("f:") ? { kind: "facility", propertyId: v.slice(2) } : { kind: v === "all" ? "all" : "company" };
    setFilter(f);
  }
  return (
    <div className="location-bar" style={{ padding: "8px 10px", fontSize: 12, color: "#c7cdd6" }}>
      {showCompanySwitcher(companies) && (
        <label style={{ display: "block", marginBottom: 8 }}>Company
          <select aria-label="Company" style={sel} value={auth?.organizationId} onChange={e => onSwitch(e.target.value)}>
            {uniqueCompanies(companies).map(c => <option key={c.organization_id} value={c.organization_id}>{c.name ?? "Company"}{c.is_home ? " (home)" : ""}</option>)}
          </select>
        </label>
      )}
      {index.tree && (
        <label style={{ display: "block" }}>Locations
          <select aria-label="Locations" style={sel} value={value} onChange={e => onFilter(e.target.value)}>
            <option value="company">This company only</option>
            <option value="all">All locations</option>
            <optgroup label="Company / branch">
              {[...index.companies.values()].map(c => <option key={c.id} value={"b:" + c.id}>{c.name}{c.access === "tree_view" ? " (view only)" : ""}</option>)}
            </optgroup>
            <optgroup label="Single location">
              {[...index.facilities.values()].map(f => <option key={f.id} value={"f:" + f.id}>{index.label({ property_id: f.id })}</option>)}
            </optgroup>
          </select>
        </label>
      )}
      {error && <div role="alert" style={{ color: "#f5a3a3", marginTop: 4 }}>{error}</div>}
    </div>
  );
}

/**
 * Create actions always target ONE company. In the combined view the user must pick it first; picking
 * another company switches into it (re-checked by the API) before the create page opens.
 */
export function useCreateTarget() {
  const { auth, adoptToken } = useAuth();
  const { index, combined, setFilter } = useLocations();
  return {
    mustChoose: combined && index.createTargets().length > 1,
    targets: index.createTargets(),
    async choose(orgId: string) {
      if (orgId === auth?.organizationId) { setFilter({ kind: "company" }); return true; }
      try { const r = await switchCompany(orgId); setFilter({ kind: "company" }); adoptToken(r.token); return true; } catch { return false; }
    },
  };
}

export function CreateLocationPicker({ onChosen }: { onChosen: () => void }) {
  const t = useCreateTarget();
  const [pick, setPick] = useState("");
  if (!t.mustChoose) return null;
  return (
    <div className="create-location-picker" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
      <select aria-label="Create at location" value={pick} onChange={e => setPick(e.target.value)}>
        <option value="">Choose one location…</option>
        {t.targets.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className="btn" disabled={!pick} onClick={async () => { if (await t.choose(pick)) onChosen(); }}>Continue</button>
    </div>
  );
}
