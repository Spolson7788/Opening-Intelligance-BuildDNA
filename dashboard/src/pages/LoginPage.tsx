import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SESSION_EXPIRED_MESSAGE, SESSION_EXPIRED_PARAM } from "../lib/session";
import { loginErrorMessage } from "../lib/scheduleUi";
import { useAuth } from "../lib/AuthContext";
import { isSiteAccessLoginError, siteAccessRenewalUrl, SITE_ACCESS_LOGIN_MESSAGE } from "../lib/siteAccess";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [siteAccess, setSiteAccess] = useState(false);
  const renewalUrl = siteAccessRenewalUrl(window.location.origin);
  const [params] = useSearchParams();
  const expired = params.get(SESSION_EXPIRED_PARAM) === "1";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSiteAccess(false);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setSiteAccess(isSiteAccessLoginError(err));
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Portfolio Dashboard</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 24 }}>
          Sign in to view your facilities.
        </p>
        {expired && !error && <p className="error-text" role="status">{SESSION_EXPIRED_MESSAGE}</p>}
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="error-text">{error}</p>}
          {error && siteAccess && <p className="error-text" role="alert">{SITE_ACCESS_LOGIN_MESSAGE}</p>}
          {error && siteAccess && renewalUrl && <a className="btn btn-primary" href={renewalUrl} target="_blank" rel="noreferrer">Renew private site access</a>}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 16, textAlign: "center" }}>
          Need access? Ask your administrator for an invite.
        </p>
        {renewalUrl && <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8, textAlign: "center" }}><a href={renewalUrl} target="_blank" rel="noreferrer">Renew private site access</a> if this private preview asks for access again.</p>}
      </div>
    </div>
  );
}
