import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { useEffect, useState } from "react";
import { LocationBar, useCreateTarget } from "./LocationBar";
import { platformMe } from "../lib/api";

function itemClass(isActive: boolean) {
  return isActive ? "nav-item active" : "nav-item";
}

export function Sidebar() {
  const { auth, logout } = useAuth();
  const createTarget = useCreateTarget();
  // M5: link shown only when the server confirms OI staff (the server re-checks every request anyway).
  const [staff, setStaff] = useState(false);
  useEffect(() => { let live = true; if (auth) platformMe().then((m) => { if (live) setStaff(m.staff); }); return () => { live = false; }; }, [auth?.userId, auth?.organizationId]);
  const canManage = auth?.role === "admin" || auth?.role === "facilities_manager";
  const canCompare = canManage || auth?.role === "technician" || auth?.role === "inspector";
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true">OI</span>
        <span>
          <span className="sidebar-brand-name">Opening Intel</span>
          <span className="sidebar-brand-sub">Portfolio</span>
        </span>
      </div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        <div className="nav-group">
          <div className="nav-label">Overview</div>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "sidebar-home active" : "sidebar-home")}>
            Portfolio Overview
          </NavLink>
          <LocationBar />
        </div>
        <div className="nav-group">
          <div className="nav-label">Openings</div>
          <Link to={{ pathname: "/", hash: "openings" }} className="nav-item">All openings</Link>
          {canManage && !createTarget.mustChoose && <Link to="/openings/new" className="nav-item">New opening</Link>}
        </div>
        <div className="nav-group">
          <div className="nav-label">Work &amp; Maintenance</div>
          <NavLink to="/work-orders" className={({ isActive }) => itemClass(isActive)}>Work Orders</NavLink>
          <NavLink to="/maintenance-schedules" className={({ isActive }) => itemClass(isActive)}>Maintenance Schedules</NavLink>
          <NavLink to="/facility-schedules" className={({ isActive }) => itemClass(isActive)}>Door Schedules</NavLink>
          {canCompare && <NavLink to="/schedule-comparisons" className={({ isActive }) => itemClass(isActive)}>Schedule Comparisons</NavLink>}
        </div>
        <div className="nav-group">
          <div className="nav-label">Planning</div>
          <NavLink to="/capital-forecast" className={({ isActive }) => itemClass(isActive)}>Capital Forecast</NavLink>
          <NavLink to="/compliance-alerts" className={({ isActive }) => itemClass(isActive)}>Alerts</NavLink>
        </div>
        <div className="nav-group">
          <div className="nav-label">Data</div>
          {canManage && !createTarget.mustChoose && <Link to="/openings/import" className="nav-item">Import Openings</Link>}
          {canManage && !createTarget.mustChoose && <Link to="/hardware/import" className="nav-item">Import Hardware</Link>}
          <NavLink to="/openings/print-labels" className={({ isActive }) => itemClass(isActive)}>Print Labels</NavLink>
          <Link to={{ pathname: "/", hash: "openings" }} className="nav-item">Export CSV</Link>
        </div>
      </nav>
      <div className="sidebar-spacer" />
      <div className="nav-admin">
        <div className="nav-label">Admin</div>
        <NavLink to="/team" className={({ isActive }) => itemClass(isActive)}>Team</NavLink>
        {canManage && <NavLink to="/audit-log" className={({ isActive }) => itemClass(isActive)}>Audit Log</NavLink>}
        {canManage && (
          <Link to="/coverage" className="nav-item">State and county</Link>
        )}
        {staff && <Link to="/staff-tools" className="nav-item">OI staff tools</Link>}
        <Link to="/change-password" className="nav-item">
          Change password
        </Link>
        <button type="button" className="nav-item" onClick={logout}>Sign Out</button>
      </div>
    </div>
  );
}
