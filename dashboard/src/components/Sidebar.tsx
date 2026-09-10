import { useAuth } from "../lib/AuthContext";

export function Sidebar() {
  const { auth, logout } = useAuth();
  return (
    <div className="sidebar">
      <div className="sidebar-brand">Opening Intel</div>
      <div style={{ color: "#c7cdd6", fontSize: 13, padding: "8px 10px", borderRadius: 6, background: "#28384b" }}>
        Portfolio Overview
      </div>
      <div className="sidebar-org">
        {auth?.role && <div style={{ textTransform: "capitalize", marginBottom: 8 }}>{auth.role.replace(/_/g, " ")}</div>}
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
