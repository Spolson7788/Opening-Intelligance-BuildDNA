import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  listProperties, listOpenings, listTeamMembers, listWorkOrders,
  createWorkOrder, updateWorkOrderStatus,
} from "../lib/api";
import type { Property, Opening, TeamMember, WorkOrder } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { Sidebar } from "../components/Sidebar";

const STATUS_LABELS: Record<string, string> = { open: "Open", in_progress: "In Progress", done: "Done", cancelled: "Cancelled" };
const STATUS_CLASSES: Record<string, string> = { open: "health-fair", in_progress: "health-fair", done: "health-good", cancelled: "health-poor" };
const PRIORITY_LABELS: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export function WorkOrdersPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const isManagement = auth?.role === "admin" || auth?.role === "facilities_manager";

  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [openingId, setOpeningId] = useState("");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    listWorkOrders(statusFilter ? { status: statusFilter } : {})
      .then(setWorkOrders)
      .catch(() => setError("Couldn't load work orders. Check your connection and try again."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [statusFilter]);

  useEffect(() => {
    if (isManagement) {
      listProperties().then(setProperties).catch(() => {});
      listTeamMembers().then(setMembers).catch(() => {});
    }
  }, [isManagement]);

  useEffect(() => {
    if (!buildingId) { setOpenings([]); return; }
    listOpenings({ building_id: buildingId }).then(setOpenings).catch(() => {});
  }, [buildingId]);

  const buildingsForProperty = properties.find((p) => p.id === propertyId)?.buildings ?? [];

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await createWorkOrder({
        opening_id: openingId,
        title,
        description: description || undefined,
        priority,
        due_date: dueDate || undefined,
        assigned_to_user_id: assigneeId || undefined,
      });
      setTitle(""); setDescription(""); setPriority("normal"); setDueDate(""); setAssigneeId("");
      setPropertyId(""); setBuildingId(""); setOpeningId("");
      setShowForm(false);
      load();
    } catch {
      setFormError("Couldn't create the work order. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onStatusChange(wo: WorkOrder, newStatus: string) {
    setActioningId(wo.id);
    try {
      await updateWorkOrderStatus(wo.id, newStatus);
      load();
    } catch {
      setError("Couldn't update that work order's status.");
    } finally {
      setActioningId(null);
    }
  }

  function canChangeStatus(wo: WorkOrder): boolean {
    if (isManagement) return true;
    return wo.assigned_to_user_id === auth?.userId;
  }

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
            <h1>Work Orders</h1>
            <p>Assigned tasks tied to a specific opening — the next step after an alert flags something.</p>
          </div>
          {isManagement && (
            <button className="btn btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Cancel" : "+ New Work Order"}
            </button>
          )}
        </div>

        {showForm && isManagement && (
          <div className="panel">
            <h2>New Work Order</h2>
            <form onSubmit={onCreate}>
              <div className="filter-bar" style={{ marginBottom: 12 }}>
                <select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setBuildingId(""); setOpeningId(""); }}>
                  <option value="">Select property…</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={buildingId} onChange={(e) => { setBuildingId(e.target.value); setOpeningId(""); }} disabled={!propertyId}>
                  <option value="">Select building…</option>
                  {buildingsForProperty.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <select value={openingId} onChange={(e) => setOpeningId(e.target.value)} disabled={!buildingId}>
                  <option value="">Select opening…</option>
                  {openings.map((o) => <option key={o.id} value={o.id}>{o.opening_code}</option>)}
                </select>
              </div>

              <div className="field">
                <label htmlFor="wo-title">Title</label>
                <input id="wo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Replace worn door closer" required disabled={!openingId} />
              </div>
              <div className="field">
                <label htmlFor="wo-description">Description (optional)</label>
                <textarea id="wo-description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!openingId} rows={3} />
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="wo-priority">Priority</label>
                  <select id="wo-priority" value={priority} onChange={(e) => setPriority(e.target.value)} disabled={!openingId}>
                    {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="wo-due">Due date (optional)</label>
                  <input id="wo-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!openingId} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="wo-assignee">Assign to (optional)</label>
                <select id="wo-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!openingId}>
                  <option value="">Unassigned</option>
                  {members.filter((m) => m.is_active).map((m) => <option key={m.id} value={m.id}>{m.full_name} ({m.role.replace(/_/g, " ")})</option>)}
                </select>
              </div>

              {formError && <p className="error-text">{formError}</p>}
              <button type="submit" className="btn btn-primary" disabled={submitting || !openingId || !title}>
                {submitting ? "Creating…" : "Create Work Order"}
              </button>
            </form>
          </div>
        )}

        <div className="panel">
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>}

        {!loading && (
          <div className="panel">
            {workOrders.length === 0 ? (
              <div className="empty-state">No work orders yet.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Title</th><th>Opening</th><th>Priority</th><th>Assigned To</th><th>Due</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {workOrders.map((wo) => (
                    <tr key={wo.id}>
                      <td>
                        {wo.title}
                        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{wo.property_name} — {wo.building_name}</div>
                      </td>
                      <td><span className="asset-plate">{wo.opening_code}</span></td>
                      <td>{PRIORITY_LABELS[wo.priority]}</td>
                      <td>{wo.assigned_to_name || <span style={{ color: "var(--text-secondary)" }}>Unassigned</span>}</td>
                      <td>{wo.due_date ? new Date(wo.due_date).toLocaleDateString() : "—"}</td>
                      <td>
                        {canChangeStatus(wo) ? (
                          <select
                            value={wo.status}
                            onChange={(e) => onStatusChange(wo, e.target.value)}
                            disabled={actioningId === wo.id}
                            style={{ height: 32, fontSize: 13 }}
                          >
                            {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                        ) : (
                          <span className={`health-pill ${STATUS_CLASSES[wo.status]}`}>{STATUS_LABELS[wo.status]}</span>
                        )}
                      </td>
                    </tr>
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
