import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { listTeamMembers, inviteTeamMember, updateTeamMember } from "../lib/api";
import type { TeamMember } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { Sidebar } from "../components/Sidebar";

const ROLES = [
  { value: "admin", label: "Admin" },
  { value: "facilities_manager", label: "Facilities Manager" },
  { value: "technician", label: "Technician" },
  { value: "inspector", label: "Inspector" },
  { value: "viewer", label: "Viewer" },
];

const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: "Full access, including managing the team itself.",
  facilities_manager: "Manages properties, openings, and reporting day to day.",
  technician: "Logs field work — service, inspections, hardware.",
  inspector: "Records inspection results.",
  viewer: "Read-only access.",
};

export function TeamPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("technician");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const isAdmin = auth?.role === "admin";

  function load() {
    setLoading(true);
    listTeamMembers()
      .then(setMembers)
      .catch(() => setError("Couldn't load your team. Check your connection and try again."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    try {
      await inviteTeamMember({ email, password, full_name: fullName, role });
      setEmail(""); setFullName(""); setPassword(""); setRole("technician");
      setShowInvite(false);
      load();
    } catch (err: any) {
      setInviteError(
        err?.message === "email_already_registered"
          ? "That email is already registered."
          : "Couldn't send the invite. Check your connection and try again."
      );
    } finally {
      setInviting(false);
    }
  }

  async function onRoleChange(member: TeamMember, newRole: string) {
    setActioningId(member.id);
    setActionError(null);
    try {
      await updateTeamMember(member.id, { role: newRole });
      load();
    } catch (err: any) {
      setActionError(
        err?.message === "cannot_remove_last_admin"
          ? `Can't change ${member.full_name}'s role — they're the only active admin. Promote someone else first.`
          : "Couldn't update that role. Check your connection and try again."
      );
    } finally {
      setActioningId(null);
    }
  }

  async function onToggleActive(member: TeamMember) {
    setActioningId(member.id);
    setActionError(null);
    try {
      await updateTeamMember(member.id, { is_active: !member.is_active });
      load();
    } catch (err: any) {
      setActionError(
        err?.message === "cannot_remove_last_admin"
          ? `Can't deactivate ${member.full_name} — they're the only active admin. Promote someone else first.`
          : "Couldn't update that member. Check your connection and try again."
      );
    } finally {
      setActioningId(null);
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
            <h1>Team</h1>
            <p>Who has access to your organization, and what they can do.</p>
          </div>
          {isAdmin && (
            <button className="btn btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setShowInvite((v) => !v)}>
              {showInvite ? "Cancel" : "+ Invite Team Member"}
            </button>
          )}
        </div>

        {!isAdmin && (
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
            Only admins can invite people or change roles. You can still see who's on the team.
          </p>
        )}

        {showInvite && isAdmin && (
          <div className="panel">
            <h2>Invite Team Member</h2>
            <form onSubmit={onInvite}>
              <div className="field">
                <label htmlFor="invite-name">Full name</label>
                <input id="invite-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="invite-email">Email</label>
                <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="invite-password">Temporary password</label>
                <input id="invite-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required placeholder="At least 8 characters — share this with them directly" />
              </div>
              <div className="field">
                <label htmlFor="invite-role">Role</label>
                <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{ROLE_DESCRIPTIONS[role]}</p>
              </div>
              {inviteError && <p className="error-text">{inviteError}</p>}
              <button type="submit" className="btn btn-primary" disabled={inviting}>
                {inviting ? "Sending invite…" : "Send Invite"}
              </button>
            </form>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
        {actionError && <p className="error-text">{actionError}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>}

        {!loading && (
          <div className="panel">
            <table>
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>{isAdmin && <th>Actions</th>}</tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isSelf = m.id === auth?.userId;
                  return (
                    <tr key={m.id} style={{ opacity: m.is_active ? 1 : 0.5 }}>
                      <td>{m.full_name}{isSelf && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}> (you)</span>}</td>
                      <td>{m.email}</td>
                      <td>
                        {isAdmin && !isSelf ? (
                          <select
                            value={m.role}
                            onChange={(e) => onRoleChange(m, e.target.value)}
                            disabled={actioningId === m.id}
                            style={{ height: 32, fontSize: 13 }}
                          >
                            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        ) : (
                          ROLES.find((r) => r.value === m.role)?.label || m.role
                        )}
                      </td>
                      <td>
                        <span className={`health-pill ${m.is_active ? "health-good" : "health-poor"}`}>
                          {m.is_active ? "Active" : "Deactivated"}
                        </span>
                      </td>
                      {isAdmin && (
                        <td>
                          {!isSelf && (
                            <button
                              className="btn btn-secondary"
                              style={{ width: "auto", padding: "0 12px", height: 30, fontSize: 12.5 }}
                              onClick={() => onToggleActive(m)}
                              disabled={actioningId === m.id}
                            >
                              {actioningId === m.id ? "…" : m.is_active ? "Deactivate" : "Reactivate"}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
