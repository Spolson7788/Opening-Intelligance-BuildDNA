import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { ApiError } from "../lib/api";
import { readLoginForm } from "../lib/loginForm";
import { loginFailureMessage } from "../lib/authResponse";
import { loginReturnPath } from "../lib/qrPayload";
import { isQrDetailsPath } from '../lib/qrLanding';
import { siteAccessRenewalUrl } from '../lib/siteAccess';
import { isSiteAccessLoginFailure } from '../lib/authResponse';

export function LoginPage() {
  const { auth, loading, identityChecking, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Same allow-listed builder as the opening detail and QR pages; null on any other origin.
  const renewalUrl = siteAccessRenewalUrl(window.location.origin);

  useEffect(() => { setError(null); setReference(null); }, [auth?.userId, auth?.organizationId]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading || identityChecking || auth || submitting) return;
    // Read the actual form before any re-render. Autofill/password managers
    // can update native inputs without firing React onChange.
    const credentials = readLoginForm(new FormData(e.currentTarget));
    setError(null);
    setReference(null);
    setSubmitting(true);
    try {
      if (isQrDetailsPath(location.state?.from)) await login(credentials.email, credentials.password, false);
      else await login(credentials.email, credentials.password);
      const from = location.state?.from;
      navigate(loginReturnPath(from), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setReference(err.reference || null);
      if (err instanceof ApiError) {
        setError(loginFailureMessage(err.status, err.message, err.reference));
      } else {
        setError("Sign-in service is unavailable. Your credentials were not rejected; try again shortly.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || identityChecking) return <div className="screen"><p role="status">Checking signed-in account.</p></div>;
  if (auth) return <div className="screen">
    <h1>Already signed in</h1>
    <p>Signed in as {auth.email || `Account ${auth.userId}`}</p>
    <p>Organization {auth.organizationId}</p>
    <p>This sign-in page does not switch accounts. To use a different account, go to Scan and sign out first. Saved changes remain associated with their original account.</p>
    <button type="button" className="btn btn-primary" onClick={() => navigate(loginReturnPath(location.state?.from), { replace: true })}>Continue with this account</button>
    <button type="button" className="btn" onClick={() => navigate("/scan", { replace: true })}>Go to Scan</button>
  </div>;

  return (
    <div className="screen" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "100vh" }}>
      <div style={{ marginBottom: 32 }}>
        <div className="asset-plate" style={{ marginBottom: 16 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Field Sign-In</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
          Sign in to scan openings and log service.
        </p>
      </div>
      {location.state?.passwordChanged === true && !error && <p role="status">Password changed. Sign in with your new password.</p>}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        {error && isSiteAccessLoginFailure(error) && renewalUrl && <a className="btn btn-primary" href={renewalUrl} target="_blank" rel="noreferrer">Renew private site access</a>}
        {reference && <p>Support reference: {reference}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
      <p style={{ textAlign: "center", marginTop: 16 }}>
        <Link to="/forgot-password" style={{ color: "#ff6a1a", fontWeight: 700 }}>Forgot password?</Link>
      </p>
      {renewalUrl && <p style={{ fontSize: 13, marginTop: 16 }}><a href={renewalUrl} target="_blank" rel="noreferrer">Renew private site access</a> if this private preview asks for access again.</p>}
    </div>
  );
}
