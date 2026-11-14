import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { techTasksEnabled } from "../lib/techTasks";
import { fetchCompanies } from "../lib/api";
import { showCompanySwitcher } from "../lib/companySwitch";
import { companyOptionLabel } from "../lib/accountLine";
import type { CompanyOption } from "../lib/companySwitch";

/** M4: shown only when the person belongs to more than one company. */
export function CompanySwitcher() {
  const { auth, switchCompany } = useAuth();
  const navigate = useNavigate();
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
      if (result.kind === "switched" && techTasksEnabled()) navigate("/tasks/day", { replace: true });
      else if (result.kind === "wait" || result.kind === "failed") setNotice(result.message);
    } finally { setBusy(false); }
  }

  return <div className="company-switch no-print">
    <label>Company{" "}
      <select aria-label="Company" value={auth.organizationId} disabled={busy} onChange={(e) => void choose(e.target.value)}>
        {companies.map((c) => <option key={c.organization_id} value={c.organization_id}>{companyOptionLabel(c)}</option>)}
      </select>
    </label>
    {notice && <p role="alert">{notice}</p>}
  </div>;
}
