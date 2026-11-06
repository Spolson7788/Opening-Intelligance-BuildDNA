import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, requestPasswordReset } from "../lib/api";

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
      setMessage("If this account can receive email, a reset link is on its way. Check your inbox. The link opens in the dashboard.");
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 503
        ? "Password reset is unavailable. Contact your account administrator."
        : "We couldn't process your request. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="screen" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "100vh" }}>
    <div className="asset-plate" style={{ marginBottom: 16 }}>OPENING-INTEL</div>
    <h1 style={{ boxShadow: "inset 0 -3px 0 #ff6a1a", display: "inline-block" }}>Reset your password</h1>
    <p>Enter the email address for your Opening Intelligence account.</p>
    <form onSubmit={submit}>
      <div className="field"><label htmlFor="reset-email">Email</label>
        <input id="reset-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Requesting…" : "Send reset link"}</button>
    </form>
    {message && <p role="status">{message}</p>}
    <p><Link to="/login">Back to sign in</Link></p>
  </div>;
}
