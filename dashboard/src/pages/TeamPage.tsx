import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  listTeamMembers, updateTeamMember, addTeamMember, listTeamInvites, createTeamInvite, resendTeamInvite, revokeTeamInvite, listProperties,
} from "../lib/api";
import type { TeamMember, TeamInvite, Property } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { Sidebar } from "../components/Sidebar";
import { defaultTestAccount, inviteSendMessage, inviteStatusLabel, teamErrorMessage } from "../lib/teamUi";
import type { AddMode } from "../lib/teamUi";

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
  technician: "Logs field work: service, inspections, hardware.",
  inspector: "Records inspection results.",
  viewer: "Read-only access.",
};

const small = { width: "auto", padding: "0 12px", height: 30, fontSize: 12.5 } as const;

export function TeamPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [mode, setMode] = useState<AddMode>("password");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("technician");
  const [isTest, setIsTest] = useState(false);
  const [testTouched, setTestTouched] = useState(false);
  const [defaultFacility, setDefaultFacility] = useState("");
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const isAdmin = auth?.role === "admin";

  function load() {
    setLoading(true);
    const jobs: Promise<unknown>[] = [listTeamMembers().then(setMembers)];
    if (isAdmin) {
      jobs.push(listTeamInvites().then((r) => { setInvites(r.invites); setEmailConfigured(r.email_configured); }));
      jobs.push(listProperties().then(setProperties).catch(() => setProperties([])));
    }
    Promise.all(jobs)
      .catch(() => setError("Couldn't load your team. Check your connection and try again."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function onEmailChange(value: string) {
    setEmail(value);
    if (!testTouched) setIsTest(defaultTestAccount(value));
  }

  function resetForm() {
    setEmail(""); setFullName(""); setPassword(""); setRole("technician"); setIsTest(false); setTestTouched(false); setDefaultFacility("");
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setAddError(null);
    setNotice(null);
    const base = { full_name: fullName, email, role, default_property_id: defaultFacility || null };
    try {
      if (mode === "password") {
        await addTeamMember({ ...base, temporary_password: password, is_test_account: isTest });
        setNotice({ tone: "ok", text: isTest
          ? `${fullName} was added as a test account. Share the temporary password with them directly.`
          : `${fullName} was added. Share the temporary password with them directly; they'll choose their own at first sign-in.` });
      } else {
        const r = await createTeamInvite(base);
        setNotice(inviteSendMessage(r.email.status, r.invite.email));
      }
      resetForm();
      setShowAdd(false);
      load();
    } catch (err: any) {
      setAddError(teamErrorMessage(err?.message));
    } finally {
      setSaving(false);
    }
  }

  async function onResend(i: TeamInvite) {
    setActioningId(i.id); setActionError(null); setNotice(null);
    try {
      const r = await resendTeamInvite(i.id);
      setNotice(inviteSendMessage(r.email.status, r.invite.email));
      load();
    } catch (err: any) {
      setActionError(teamErrorMessage(err?.message));
    } finally { setActioningId(null); }
  }

  async function onRevoke(i: TeamInvite) {
    if (!window.confirm(`Revoke the invite for ${i.email}? The link will stop working.`)) return;
    setActioningId(i.id); setActionError(null);
    try { await revokeTeamInvite(i.id); load(); }
    catch (err: any) { setActionError(teamErrorMessage(err?.message)); }
    finally { setActioningId(null); }
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
          ? `Can't change ${member.full_name}'s role: they're the only active admin. Promote someone else first.`
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
          ? `Can't deactivate ${member.full_name}: they're the only active admin. Promote someone else first.`
          : "Couldn't update that member. Check your connection and try again."
      );
    } finally {
      setActioningId(null);
    }
  }

  const facilityName = (id?: string | null) => (id ? properties.find((p) => p.id === id)?.name ?? "Facility" : "");

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          &larr; Back to Portfolio
        </button>

        <div className="page-header">
          <div>
            <h1>Team</h1>
            <p>Who has access to your organization, and what they can do.</p>
          </div>
          {isAdmin && (
            <button className="btn btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? "Cancel" : "+ Add team member"}
            </button>
          )}
        </div>

        {!isAdmin && (
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
            Only admins can add people or change roles. You can still see who's on the team.
          </p>
        )}

        {notice && <p className={notice.tone === "error" ? "error-text" : ""} role="status" style={notice.tone === "warn" ? { color: "#9a6700", fontSize: 13 } : notice.tone === "ok" ? { color: "var(--text-secondary)", fontSize: 13 } : undefined}>{notice.text}</p>}

        {showAdd && isAdmin && (
          <div className="panel">
            <h2>Add team member</h2>
            <div role="radiogroup" aria-label="How to add" style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 13 }}>
              <label><input type="radio" name="add-mode" checked={mode === "password"} onChange={() => setMode("password")} /> Set temporary password</label>
              <label><input type="radio" name="add-mode" checked={mode === "invite"} onChange={() => setMode("invite")} /> Email invite</label>
            </div>
            {mode === "invite" && emailConfigured === false && (
              <p style={{ color: "#9a6700", fontSize: 12.5 }}>Email isn't configured yet. The invite will be saved but not sent.</p>
            )}
            <form onSubmit={onAdd}>
              <div className="field">
                <label htmlFor="add-name">Full name</label>
                <input id="add-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="add-email">Email</label>
                <input id="add-email" type="email" value={email} onChange={(e) => onEmailChange(e.target.value)} required />
              </div>
              {mode === "password" && (
                <>
                  <div className="field">
                    <label htmlFor="add-password">Temporary password</label>
                    <input id="add-password" type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={72} required placeholder="At least 12 characters; share this with them directly" />
                  </div>
                  <div className="field">
                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="checkbox" checked={isTest} onChange={(e) => { setIsTest(e.target.checked); setTestTouched(true); }} style={{ width: "auto" }} />
                      Test account (no password change required at first sign-in)
                    </label>
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>For non-production testing only. Recorded in the audit log.</p>
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="add-role">Role</label>
                <select id="add-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{ROLE_DESCRIPTIONS[role]}</p>
              </div>
              <div className="field">
                <label htmlFor="add-facility">Default facility (optional)</label>
                <select id="add-facility" value={defaultFacility} onChange={(e) => setDefaultFacility(e.target.value)}>
                  <option value="">None</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>Pre-selected for them in the field app.</p>
              </div>
              {addError && <p className="error-text">{addError}</p>}
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : mode === "password" ? "Add team member" : "Send invite"}
              </button>
            </form>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
        {actionError && <p className="error-text">{actionError}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading...</p>}

        {!loading && isAdmin && invites.length > 0 && (
          <div className="panel">
            <h2>Pending invites</h2>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th>Actions</th></tr></thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.full_name}</td>
                    <td>{i.email}</td>
                    <td>{ROLES.find((r) => r.value === i.role)?.label || i.role}</td>
                    <td>{inviteStatusLabel(i)}</td>
                    <td>{new Date(i.expires_at).toLocaleDateString()}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-secondary" style={small} disabled={actioningId === i.id} onClick={() => onResend(i)}>Resend</button>
                      <button className="btn btn-secondary" style={small} disabled={actioningId === i.id} onClick={() => onRevoke(i)}>Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
                      <td>
                        {m.full_name}{isSelf && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}> (you)</span>}
                        {m.is_test_account && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}> (test account)</span>}
                        {m.default_property_id && <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>Default: {facilityName(m.default_property_id)}</div>}
                      </td>
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
                          {m.is_active ? (m.must_change_password ? "Active (must set password)" : "Active") : "Deactivated"}
                        </span>
                      </td>
                      {isAdmin && (
                        <td>
                          {!isSelf && (
                            <button
                              className="btn btn-secondary"
                              style={small}
                              onClick={() => onToggleActive(m)}
                              disabled={actioningId === m.id}
                            >
                              {actioningId === m.id ? "..." : m.is_active ? "Deactivate" : "Reactivate"}
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