import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, confirmPasswordReset, requestPasswordReset } from "../lib/api";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await requestPasswordReset(email);
      setMessage("If this account can receive email, a reset link is on its way. Check your inbox.");
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 503
        ? "Password reset is unavailable. Contact your account administrator."
        : "We couldn't process your request. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="login-shell"><div className="login-card">
    <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
    <h1>Reset your password</h1>
    <p>Enter the email address for your Opening Intelligence account. The link opens on this dashboard.</p>
    <form onSubmit={submit}>
      <div className="field"><label htmlFor="reset-email">Email</label>
        <input id="reset-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Requesting…" : "Send reset link"}</button>
    </form>
    {message && <p role="status">{message}</p>}
    <p><Link to="/login">Back to sign in</Link></p>
  </div></div>;
}

export function ResetPasswordPage() {
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    window.history.replaceState(null, "", window.location.pathname);
    return value;
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) { setMessage("Passwords do not match."); return; }
    setBusy(true);
    setMessage("");
    try {
      await confirmPasswordReset(token, password);
      setDone(true);
      setPassword(""); setConfirm("");
      setMessage("Password changed. Sign in with your new password.");
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 400
        ? "This reset link is invalid or expired. Request a new one."
        : "We couldn't reset your password. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="login-shell"><div className="login-card">
    <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
    <h1>Choose a new password</h1>
    {!token && <p>This link is missing its reset code. <Link to="/forgot-password">Request a new link</Link>.</p>}
    {token && !done && <form onSubmit={submit}>
      <div className="field"><label htmlFor="new-password">New password (12 to 72 characters)</label>
        <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <div className="field"><label htmlFor="confirm-password">Confirm new password</label>
        <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Updating…" : "Save new password"}</button>
    </form>}
    {message && <p role="status">{message}</p>}
    <p><Link to="/login">Back to sign in</Link></p>
  </div></div>;
}
