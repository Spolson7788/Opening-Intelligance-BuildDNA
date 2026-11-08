import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext";
import { fetchCompanies } from "../lib/api";
import { showCompanySwitcher } from "../lib/companySwitch";
import type { CompanyOption } from "../lib/companySwitch";

/** M4: shown only when the person belongs to more than one company. */
export function CompanySwitcher() {
  const { auth, switchCompany } = useAuth();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!auth || auth.mustChangePassword) { setCompanies([]); return; }
    fetchCompanies().then((r) => { if (live) setCompanies(r.companies); }).catch(() => { if (live) setCompanies([]); });
    return () => { live = false; };
  }, [auth?.userId, auth?.organizationId, auth?.mustChangePassword]);
  if (!auth || !showCompanySwitcher(companies)) return null;

  async function choose(orgId: string) {
    if (busy || !auth || orgId === auth.organizationId) return;
    setBusy(true); setNotice(null);
    try {
      let result = await switchCompany(orgId, false);
      if (result.kind === "confirm" && window.confirm(result.message)) result = await switchCompany(orgId, true);
      if (result.kind === "wait" || result.kind === "failed") setNotice(result.message);
    } finally { setBusy(false); }
  }

  return <div className="no-print" style={{ padding: "4px 16px" }}>
    <label>Company{" "}
      <select aria-label="Company" value={auth.organizationId} disabled={busy} onChange={(e) => void choose(e.target.value)}>
        {companies.map((c) => <option key={c.organization_id} value={c.organization_id}>{c.name || c.organization_id}{c.access === "tree_view" ? " (view only)" : ""}</option>)}
      </select>
    </label>
    {notice && <p role="alert">{notice}</p>}
  </div>;
}
