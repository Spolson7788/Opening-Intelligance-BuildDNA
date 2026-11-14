import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import logo from "../../../field-app/src/assets/oi-logo.png";
import { facilityDashboardAccess, listCompanies, switchCompany, type CompanyChoice } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { officeCompanies } from "../lib/officeCompanies";
import "../company.css";

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="c04-back" to={to}>{children}</Link>;
}

export function CompanyShell({ title, children }: { title: string; children: ReactNode }) {
  const { auth, adoptToken } = useAuth();
  const [facilityLink, setFacilityLink] = useState(false);
  const [companies, setCompanies] = useState<CompanyChoice[]>([]);
  const [switchError, setSwitchError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    facilityDashboardAccess().then(() => { if (live) setFacilityLink(true); }).catch(() => { if (live) setFacilityLink(false); });
    listCompanies().then((rows) => { if (live) setCompanies(officeCompanies(rows)); }).catch(() => { if (live) setCompanies([]); });
    return () => { live = false; };
  }, [auth?.organizationId]);
  async function onCompany(id: string) {
    if (!id || id === auth?.organizationId) return;
    setSwitchError(null);
    try {
      const next = await switchCompany(id);
      adoptToken(next.token);
    } catch {
      setSwitchError("Could not switch company.");
    }
  }
  return (
    <div className="c04-page">
      <header className="c04-top">
        <div className="c04-top-inner">
          <img className="c04-logo" src={logo} alt="Opening Intelligence" />
          <div>
            <h1>Company dashboard</h1>
            <p className="c04-sub">{title}</p>
          </div>
          {companies.length > 0 && (
            <label className="c04-company">Company
              <select aria-label="Company" value={auth?.organizationId ?? ""} onChange={(event) => onCompany(event.target.value)}>
                {companies.map((company) => (
                  <option key={company.organization_id} value={company.organization_id}>{company.name || "Company"}{company.is_home ? " (home)" : ""}</option>
                ))}
              </select>
            </label>
          )}
          <div className="c04-brand">
            {facilityLink && <a href="/facility-dashboard/">Facility Dashboard</a>}
            <div>Opening Intelligence</div>
            <div>Administrators and managers</div>
          </div>
        </div>
        {switchError && <p className="c04-error" role="alert">{switchError}</p>}
      </header>
      <main className="c04-main">{children}</main>
    </div>
  );
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function plainType(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatMoney(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "Estimate on file";
  return (minor / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
