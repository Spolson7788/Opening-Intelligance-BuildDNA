import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuditLog } from "../lib/api";
import type { AuditLogEntry } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

export function AuditLogPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetchAuditLog()
      .then(setEntries)
      .catch(() => setError("Couldn't load the audit log. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        <div className="page-header">
          <div>
            <h1>Audit Log</h1>
            <p>Who changed what, when. Shows the most recent 100 successful changes.</p>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>}

        {!loading && !error && (
          <div className="panel">
            {entries.length === 0 ? (
              <div className="empty-state">No changes recorded yet.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>When</th><th>Who</th><th>Action</th><th></th></tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <Fragment key={e.id}>
                      <tr onClick={() => setExpandedId(expandedId === e.id ? null : e.id)} style={{ cursor: "pointer" }}>
                        <td style={{ whiteSpace: "nowrap", fontSize: 12.5, color: "var(--text-secondary)" }}>
                          {new Date(e.created_at).toLocaleString()}
                        </td>
                        <td>
                          {e.user_full_name}
                          <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{e.user_email}</div>
                        </td>
                        <td>{e.action}</td>
                        <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                          {expandedId === e.id ? "Hide details ▲" : "Details ▼"}
                        </td>
                      </tr>
                      {expandedId === e.id && (
                        <tr>
                          <td colSpan={4} style={{ background: "var(--bg)", fontSize: 12 }}>
                            <div style={{ padding: "8px 4px" }}>
                              <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
                                {e.method} {e.path}
                              </div>
                              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
                                {JSON.stringify(e.request_body, null, 2)}
                              </pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
