import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { KeyboardEvent, MouseEvent } from "react";
import { useAuth } from "../lib/AuthContext";
import { useEffect, useRef, useState } from "react";
import { LocationBar, useCreateTarget } from "./LocationBar";
import { platformMe } from "../lib/api";
import { clickOpeningsExport, scrollToOpeningsWhenReady } from "../lib/scrollToOpenings";

function itemClass(isActive: boolean) {
  return isActive ? "nav-item active" : "nav-item";
}

export function Sidebar() {
  const { auth, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const createTarget = useCreateTarget();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // M5: link shown only when the server confirms OI staff (the server re-checks every request anyway).
  const [staff, setStaff] = useState(false);
  useEffect(() => { let live = true; if (auth) platformMe().then((m) => { if (live) setStaff(m.staff); }); return () => { live = false; }; }, [auth?.userId, auth?.organizationId]);
  useEffect(() => { setOpen(false); }, [location.pathname]);
  const canManage = auth?.role === "admin" || auth?.role === "facilities_manager";
  const canCompare = canManage || auth?.role === "technician" || auth?.role === "inspector";

  function plainClick(event: MouseEvent) {
    return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }
  function revealOpenings() {
    const samePage = location.pathname === "/";
    if (location.pathname !== "/" || location.hash !== "#openings") {
      navigate({ pathname: "/", hash: "openings" });
    }
    const scroll = () => { void scrollToOpeningsWhenReady(); };
    if (samePage && open) {
      setOpen(false);
      requestAnimationFrame(() => requestAnimationFrame(scroll));
      return;
    }
    setOpen(false);
    scroll();
  }
  function onAllOpenings(event: MouseEvent<HTMLAnchorElement>) {
    if (plainClick(event)) return;
    event.preventDefault();
    revealOpenings();
  }
  function onExport(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    revealOpenings();
    void clickOpeningsExport();
  }
  function onToggle() {
    setOpen((current) => {
      const next = !current;
      if (next) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("a, button")?.focus());
      return next;
    });
  }
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    toggleRef.current?.focus();
  }

  return (
    <div className={open ? "sidebar is-open" : "sidebar"} onKeyDown={onMenuKeyDown}>
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">OI</span>
          <span>
            <span className="sidebar-brand-name">Opening Intel</span>
            <span className="sidebar-brand-sub">Portfolio</span>
          </span>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={open}
          aria-controls="sidebar-menu"
          ref={toggleRef}
          onClick={onToggle}
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <div id="sidebar-menu" className="sidebar-panel" ref={menuRef} onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) setOpen(false);
      }}>
      <nav className="sidebar-nav" aria-label="Main navigation">
        <div className="nav-group">
          <div className="nav-label">Overview</div>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "sidebar-home active" : "sidebar-home")}>
            Portfolio Overview
          </NavLink>
          <NavLink to="/how-to-use" className={({ isActive }) => itemClass(isActive)}>How to use</NavLink>
          <LocationBar />
        </div>
        <div className="nav-group">
          <div className="nav-label">Openings</div>
          <Link to={{ pathname: "/", hash: "openings" }} className="nav-item" onClick={onAllOpenings}>All openings</Link>
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
          {canManage && <NavLink to="/inspection-visits" className={({ isActive }) => itemClass(isActive)}>Inspection visits</NavLink>}
        </div>
        <div className="nav-group">
          <div className="nav-label">Data</div>
          {canManage && !createTarget.mustChoose && <Link to="/openings/import" className="nav-item">Import Openings</Link>}
          {canManage && !createTarget.mustChoose && <Link to="/hardware/import" className="nav-item">Import Hardware</Link>}
          <NavLink to="/openings/print-labels" className={({ isActive }) => itemClass(isActive)}>Print Labels</NavLink>
          <button type="button" className="nav-item" onClick={onExport}>Export CSV</button>
        </div>
      </nav>
      <div className="sidebar-spacer" />
      <div className="nav-admin">
        <div className="nav-label">Admin</div>
        <NavLink to="/team" className={({ isActive }) => itemClass(isActive)}>Team</NavLink>
        {canManage && <NavLink to="/purchasing-email" className={({ isActive }) => itemClass(isActive)}>Purchasing email</NavLink>}
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
    </div>
  );
}
