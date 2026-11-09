import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { fetchCompanies } from "../lib/api";
import { activeCompanyName, signedInLabel } from "../lib/accountLine";
import type { CompanyOption } from "../lib/companySwitch";

export function AccountIdentity() {
  const { auth, loading, identityChecking } = useAuth();
  const [companies, setCompanies] = useState<CompanyOption[] | null>(null);
  useEffect(() => {
    let live = true;
    if (!auth || auth.mustChangePassword) { setCompanies(null); return; }
    setCompanies(null);
    fetchCompanies().then((result) => { if (live) setCompanies(result.companies); }).catch(() => { if (live) setCompanies([]); });
    return () => { live = false; };
  }, [auth?.userId, auth?.organizationId, auth?.mustChangePassword]);
  if (loading || identityChecking || !auth) return null;
  const who = signedInLabel(auth.email, auth.userId);
  const company = companies === null ? "Loading company" : activeCompanyName(companies, auth.organizationId);
  const line = `Signed in as ${who} · ${company}`;
  return <aside aria-label="Current account" className="no-print">
    <p className="account-line" title={line}>{line}</p>
    <Link className="account-sync-link" to="/sync-issues">Synchronization review</Link>
  </aside>;
}
