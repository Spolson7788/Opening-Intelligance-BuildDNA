import { useEffect, useState, type ReactNode } from "react";
import logo from "../../../field-app/src/assets/oi-logo.png";
import { facilityDashboardAccess } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import "../company.css";

export function CompanyShell({ title, children }: { title: string; children: ReactNode }) {
  const { auth } = useAuth();
  const [facilityLink, setFacilityLink] = useState(false);
  useEffect(() => {
    let live = true;
    facilityDashboardAccess().then(() => { if (live) setFacilityLink(true); }).catch(() => { if (live) setFacilityLink(false); });
    return () => { live = false; };
  }, [auth?.organizationId]);
  return (
    <div className="c04-page">
      <header className="c04-top">
        <div className="c04-top-inner">
          <img className="c04-logo" src={logo} alt="Opening Intelligence" />
          <div>
            <h1>Company dashboard</h1>
            <p className="c04-sub">{title}</p>
          </div>
          <div className="c04-brand">
            {facilityLink && <a href="/facility-dashboard/">Facility Dashboard</a>}
            <div>Opening Intelligence</div>
            <div>Administrators and managers</div>
          </div>
        </div>
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
