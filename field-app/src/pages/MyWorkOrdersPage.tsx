import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchMyWorkOrders, updateMyWorkOrderStatus } from "../lib/api";
import type { FieldWorkOrder } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { SyncBadge } from "../components/SyncBadge";

const PRIORITY_BORDER: Record<string, string> = {
  urgent: "health-poor",
  high: "health-poor",
  normal: "health-fair",
  low: "health-good",
};

const STATUS_LABELS: Record<string, string> = { open: "Open", in_progress: "In Progress", done: "Done", cancelled: "Cancelled" };

export function MyWorkOrdersPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [workOrders, setWorkOrders] = useState<FieldWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  function load() {
    if (!auth?.userId) return;
    setLoading(true);
    setError(null);
    fetchMyWorkOrders(auth.userId)
      .then(setWorkOrders)
      .catch(() => setError("Couldn't load your work orders — check your connection."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [auth?.userId]);

  async function onAdvanceStatus(wo: FieldWorkOrder, newStatus: string) {
    setActioningId(wo.id);
    try {
      await updateMyWorkOrderStatus(wo.id, newStatus);
      load();
    } catch {
      setError("Couldn't update that job — check your connection and try again.");
    } finally {
      setActioningId(null);
    }
  }

  const activeOrders = workOrders.filter((w) => w.status === "open" || w.status === "in_progress");
  const finishedOrders = workOrders.filter((w) => w.status === "done" || w.status === "cancelled");

  return (
    <div className="app-shell">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate("/scan")}>
          ← Back
        </button>
        <h1>My Work Orders</h1>
        <SyncBadge />
      </div>
      <div className="screen">
        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>Loading…</p>}

        {!loading && workOrders.length === 0 && (
          <div className="card" style={{ textAlign: "center", color: "var(--text-secondary)" }}>
            Nothing assigned to you right now.
          </div>
        )}

        {activeOrders.map((wo) => (
          <div key={wo.id} className={`card card-health ${PRIORITY_BORDER[wo.priority]}`}>
            <div
              onClick={() => navigate(`/opening/${wo.opening_id}`)}
              style={{ cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <strong>{wo.title}</strong>
                <span className="badge">{STATUS_LABELS[wo.status]}</span>
              </div>
              <p style={{ margin: "4px 0 2px", fontSize: 13, color: "var(--text-secondary)" }}>
                {wo.opening_code} — {wo.property_name}, {wo.building_name}
              </p>
              {wo.due_date && (
                <p style={{ margin: "0 0 6px", fontSize: 12.5, color: "var(--text-secondary)" }}>
                  Due {new Date(wo.due_date).toLocaleDateString()}
                </p>
              )}
              {wo.description && <p style={{ margin: "6px 0 0", fontSize: 13.5 }}>{wo.description}</p>}
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              {wo.status === "open" && (
                <button
                  className="btn btn-primary"
                  style={{ minHeight: 40 }}
                  disabled={actioningId === wo.id}
                  onClick={() => onAdvanceStatus(wo, "in_progress")}
                >
                  {actioningId === wo.id ? "…" : "Start Job"}
                </button>
              )}
              {wo.status === "in_progress" && (
                <button
                  className="btn btn-primary"
                  style={{ minHeight: 40 }}
                  disabled={actioningId === wo.id}
                  onClick={() => onAdvanceStatus(wo, "done")}
                >
                  {actioningId === wo.id ? "…" : "Mark Done"}
                </button>
              )}
            </div>
          </div>
        ))}

        {finishedOrders.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 20 }}>Recently finished</div>
            {finishedOrders.map((wo) => (
              <div key={wo.id} className="card" style={{ opacity: 0.7 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{wo.title}</span>
                  <span className="badge">{STATUS_LABELS[wo.status]}</span>
                </div>
                <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--text-secondary)" }}>{wo.opening_code}</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
