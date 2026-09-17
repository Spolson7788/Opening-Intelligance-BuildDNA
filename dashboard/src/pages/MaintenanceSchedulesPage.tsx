import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  listProperties, listOpenings, listTeamMembers, listMaintenanceSchedules,
  createMaintenanceSchedule, updateMaintenanceSchedule, triggerDueMaintenance,
} from "../lib/api";
import type { Property, Opening, TeamMember, MaintenanceSchedule } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { Sidebar } from "../components/Sidebar";

const PRIORITY_LABELS: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const INTERVAL_LABELS: Record<string, string> = { days: "day(s)", weeks: "week(s)", months: "month(s)", years: "year(s)" };

export function MaintenanceSchedulesPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const isManagement = auth?.role === "admin" || auth?.role === "facilities_manager";

  const [schedules, setSchedules] = useState<MaintenanceSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

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
  const [intervalCount, setIntervalCount] = useState(3);
  const [intervalUnit, setIntervalUnit] = useState("months");
  const [assigneeId, setAssigneeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    listMaintenanceSchedules()
      .then(setSchedules)
      .catch(() => setError("Couldn't load maintenance schedules. Check your connection and try again."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

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
      await createMaintenanceSchedule({
        opening_id: openingId,
        title,
        description: description || undefined,
        priority,
        interval_unit: intervalUnit,
        interval_count: intervalCount,
        assigned_to_user_id: assigneeId || undefined,
      });
      setTitle(""); setDescription(""); setPriority("normal"); setIntervalCount(3); setIntervalUnit("months"); setAssigneeId("");
      setPropertyId(""); setBuildingId(""); setOpeningId("");
      setShowForm(false);
      load();
    } catch {
      setFormError("Couldn't create the schedule. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggleActive(schedule: MaintenanceSchedule) {
    setActioningId(schedule.id);
    try {
      await updateMaintenanceSchedule(schedule.id, { is_active: !schedule.is_active });
      load();
    } catch {
      setError("Couldn't update that schedule.");
    } finally {
      setActioningId(null);
    }
  }

  async function onCheckNow() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await triggerDueMaintenance();
      setCheckResult(res.generated > 0 ? `Generated ${res.generated} work order${res.generated === 1 ? "" : "s"}.` : "Nothing due right now.");
      load();
    } catch {
      setError("Couldn't check for due maintenance.");
    } finally {
      setChecking(false);
    }
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
            <h1>Maintenance Schedules</h1>
            <p>Recurring work — a schedule automatically creates a new work order each time it comes due.</p>
          </div>
          {isManagement && (
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-secondary" style={{ width: "auto", padding: "0 16px" }} onClick={onCheckNow} disabled={checking}>
                {checking ? "Checking…" : "Check Now"}
              </button>
              <button className="btn btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setShowForm((v) => !v)}>
                {showForm ? "Cancel" : "+ New Schedule"}
              </button>
            </div>
          )}
        </div>

        {checkResult && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>{checkResult}</p>}

        {showForm && isManagement && (
          <div className="panel">
            <h2>New Maintenance Schedule</h2>
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
                <label htmlFor="ms-title">Title</label>
                <input id="ms-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Quarterly closer adjustment" required disabled={!openingId} />
              </div>
              <div className="field">
                <label htmlFor="ms-description">Description (optional)</label>
                <textarea id="ms-description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!openingId} rows={3} />
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="ms-priority">Priority</label>
                  <select id="ms-priority" value={priority} onChange={(e) => setPriority(e.target.value)} disabled={!openingId}>
                    {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="ms-interval-count">Repeat every</label>
                  <input
                    id="ms-interval-count" type="number" min={1} value={intervalCount}
                    onChange={(e) => setIntervalCount(Number(e.target.value) || 1)} disabled={!openingId}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="ms-interval-unit">&nbsp;</label>
                  <select id="ms-interval-unit" value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value)} disabled={!openingId}>
                    {Object.entries(INTERVAL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="ms-assignee">Assign to (optional)</label>
                <select id="ms-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!openingId}>
                  <option value="">Unassigned</option>
                  {members.filter((m) => m.is_active).map((m) => <option key={m.id} value={m.id}>{m.full_name} ({m.role.replace(/_/g, " ")})</option>)}
                </select>
              </div>

              {formError && <p className="error-text">{formError}</p>}
              <button type="submit" className="btn btn-primary" disabled={submitting || !openingId || !title}>
                {submitting ? "Creating…" : "Create Schedule"}
              </button>
            </form>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>}

        {!loading && (
          <div className="panel">
            {schedules.length === 0 ? (
              <div className="empty-state">No recurring maintenance schedules yet.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Title</th><th>Opening</th><th>Repeats</th><th>Assigned To</th><th>Next Due</th><th>Status</th>{isManagement && <th></th>}</tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.5 }}>
                      <td>
                        {s.title}
                        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{s.property_name} — {s.building_name}</div>
                      </td>
                      <td><span className="asset-plate">{s.opening_code}</span></td>
                      <td>Every {s.interval_count} {INTERVAL_LABELS[s.interval_unit]}</td>
                      <td>{s.assigned_to_name || <span style={{ color: "var(--text-secondary)" }}>Unassigned</span>}</td>
                      <td>{new Date(s.next_due_date).toLocaleDateString()}</td>
                      <td>
                        <span className={`health-pill ${s.is_active ? "health-good" : "health-poor"}`}>
                          {s.is_active ? "Active" : "Paused"}
                        </span>
                      </td>
                      {isManagement && (
                        <td>
                          <button
                            className="btn btn-secondary"
                            style={{ width: "auto", padding: "0 12px", height: 30, fontSize: 12.5 }}
                            onClick={() => onToggleActive(s)}
                            disabled={actioningId === s.id}
                          >
                            {actioningId === s.id ? "…" : s.is_active ? "Pause" : "Resume"}
                          </button>
                        </td>
                      )}
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
