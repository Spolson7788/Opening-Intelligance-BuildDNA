import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Sidebar } from "../components/Sidebar";
import { useAuth } from "../lib/AuthContext";
import { ApiError, changePassword } from "../lib/api";

export function ChangePasswordPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) { setError("New passwords do not match."); return; }
    setBusy(true);
    setError("");
    try {
      await changePassword(current, next);
      setCurrent(""); setNext(""); setConfirm("");
      // The API revoked the old session; clear its browser copy immediately.
      logout();
      navigate("/login", { replace: true, state: { passwordChanged: true } });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 && e.message === "current_password_incorrect"
        ? "Your current password is incorrect."
        : e instanceof ApiError && e.message === "password_unchanged"
          ? "Choose a different new password."
          : "Couldn't change your password. Please try again.");
    } finally { setBusy(false); }
  }

  return <div className="app-shell"><Sidebar /><main className="main">
    <div className="page-header"><div><h1>Change password</h1><p>For your Opening Intelligence account</p></div></div>
    <div className="login-card" style={{ maxWidth: 480 }}>
      <form onSubmit={submit}>
        <div className="field"><label htmlFor="current-password">Current password</label>
          <input id="current-password" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></div>
        <div className="field"><label htmlFor="next-password">New password (at least 12 characters)</label>
          <input id="next-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={next} onChange={e => setNext(e.target.value)} /></div>
        <div className="field"><label htmlFor="confirm-password">Confirm new password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p><Link to="/forgot-password">Forgot your current password?</Link></p>
      <p><Link to="/">Back to dashboard</Link></p>
    </div>
  </main></div>;
}
