import { Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { useEffect, useState } from "react";
import { LocationBar } from "./LocationBar";
import { platformMe } from "../lib/api";

export function Sidebar() {
  const { auth, logout } = useAuth();
  // M5: link shown only when the server confirms OI staff (the server re-checks every request anyway).
  const [staff, setStaff] = useState(false);
  useEffect(() => { let live = true; if (auth) platformMe().then((m) => { if (live) setStaff(m.staff); }); return () => { live = false; }; }, [auth?.userId, auth?.organizationId]);
  return (
    <div className="sidebar">
      <div className="sidebar-brand">Opening Intel</div>
      <div style={{ color: "#c7cdd6", fontSize: 13, padding: "8px 10px", borderRadius: 6, background: "#28384b" }}>
        Portfolio Overview
      </div>
      <LocationBar />
      <div className="sidebar-org">
        {auth?.role && <div style={{ textTransform: "capitalize", marginBottom: 8 }}>{auth.role.replace(/_/g, " ")}</div>}
        {staff && <Link to="/staff-tools" style={{ display: "block", color: "#9aa4b2", fontSize: 12, marginBottom: 6 }}>OI staff tools</Link>}
        <Link to="/change-password" style={{ display: "block", color: "#9aa4b2", fontSize: 12, marginBottom: 6 }}>
          Change password
        </Link>
        <button
          onClick={logout}
          style={{ background: "none", border: "none", color: "#9aa4b2", cursor: "pointer", padding: 0, fontSize: 12 }}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
