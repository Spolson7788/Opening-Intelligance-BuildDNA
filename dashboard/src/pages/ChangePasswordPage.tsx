import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { changePassword, passwordErrorMessage, PASSWORD_RULE } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

// M5: everyone can change their password; required at first sign-in for accounts an
// admin created with a temporary password (unless marked as a test account).
export function ChangePasswordPage() {
  const { auth, adoptToken, logout } = useAuth();
  const navigate = useNavigate();
  const forced = auth?.mustChangePassword === true;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) { setError("The new passwords don't match."); return; }
    setSaving(true);
    try {
      const { token } = await changePassword(current, next);
      setCurrent(""); setNext(""); setConfirm("");
      adoptToken(token);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(passwordErrorMessage(err?.message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>{forced ? "Choose a new password" : "Change password"}</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 24 }}>
          {forced ? "Your admin gave you a temporary password. Choose your own before continuing." : "Other signed-in devices will be signed out."}
        </p>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="cp-current">{forced ? "Temporary password" : "Current password"}</label>
            <input id="cp-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="cp-new">New password</label>
            <input id="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} maxLength={72} required />
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{PASSWORD_RULE}</p>
          </div>
          <div className="field">
            <label htmlFor="cp-confirm">Confirm new password</label>
            <input id="cp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save new password"}</button>
        </form>
        <button onClick={forced ? logout : () => navigate(-1)} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, marginTop: 16, padding: 0 }}>
          {forced ? "Sign out" : "Cancel"}
        </button>
      </div>
    </div>
  );
}