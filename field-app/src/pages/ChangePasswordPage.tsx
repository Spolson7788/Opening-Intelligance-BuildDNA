import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { changePassword, changePasswordErrorMessage } from "../lib/api";

// M5: change your password. Required at first sign-in for accounts an admin created with a
// temporary password (not test accounts). Afterwards you sign in again with the new one, so
// the device starts a clean session for the same account.
export function ChangePasswordPage() {
  const { auth, logout } = useAuth();
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
      await changePassword(current, next);
      setCurrent(""); setNext(""); setConfirm("");
      await logout();
      navigate("/login", { replace: true, state: { passwordChanged: true } });
    } catch (err: any) {
      setError(changePasswordErrorMessage(err?.message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-shell c04"><div className="screen">
      <p className="c04-kicker">Field app</p>
      <h1>{forced ? "Choose a new password" : "Change password"}</h1>
      <p>{forced ? "Your admin gave you a temporary password. Choose your own before continuing." : "You'll sign in again with the new password."}</p>
      <form className="c04-band" onSubmit={onSubmit}>
        <label htmlFor="cp-current">{forced ? "Temporary password" : "Current password"}</label>
        <input id="cp-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <label htmlFor="cp-new">New password (12 to 72 characters)</label>
        <input id="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} maxLength={72} required />
        <label htmlFor="cp-confirm">Confirm new password</label>
        <input id="cp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save new password"}</button>
      </form>
      <button type="button" className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => (forced ? void logout() : navigate("/scan"))}>
        {forced ? "Sign Out" : "Cancel"}
      </button>
    </div></div>
  );
}