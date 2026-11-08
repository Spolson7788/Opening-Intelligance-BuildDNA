import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { SESSION_EXPIRED_MESSAGE, SESSION_EXPIRED_PARAM } from "../lib/session";
import { loginErrorMessage } from "../lib/scheduleUi";
import { StaffMfaRequired, useAuth } from "../lib/AuthContext";
import { resendStaffSignInCode, verifyStaffMfa } from "../lib/api";
import { isSiteAccessLoginError, siteAccessRenewalUrl, SITE_ACCESS_LOGIN_MESSAGE } from "../lib/siteAccess";
import { playLoginIntro } from "../lib/loginIntro";
import { clearPendingStaffSignIn, readPendingStaffSignIn, savePendingStaffSignIn, type PendingStaffSignIn } from "../lib/staffSignInPending";

function mfaMessage(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  if (code === "mfa_code_reused") return "That code was already used. Send a new one.";
  if (code === "mfa_code_expired") return "That code expired. Send a new one.";
  if (code === "mfa_rate_limited") return "Too many attempts. Wait 15 minutes, or ask another staff member to clear the lockout.";
  if (code === "resend_cooldown") return "Wait about a minute before sending another code.";
  if (code === "mfa_unavailable") return "The sign-in code could not be emailed. Try again shortly.";
  if (code === "invalid_mfa_code") return "That code wasn't accepted. Check the email and try again.";
  return loginErrorMessage(err);
}

function browserSession(): Storage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

export function LoginPage() {
  const { login, adoptToken } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [siteAccess, setSiteAccess] = useState(false);
  const [pending, setPending] = useState<PendingStaffSignIn | null>(() => readPendingStaffSignIn(browserSession()));
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const renewalUrl = siteAccessRenewalUrl(window.location.origin);
  const [params] = useSearchParams();
  const expired = params.get(SESSION_EXPIRED_PARAM) === "1";
  const wait = pending ? Math.max(0, 60 - Math.floor((now - pending.sentAt) / 1000)) : 0;

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  function remember(next: PendingStaffSignIn) {
    const store = browserSession();
    if (store) savePendingStaffSignIn(next, store);
    setPending(next);
    setNow(Date.now());
  }

  function forget() {
    const store = browserSession();
    if (store) clearPendingStaffSignIn(store);
    setPending(null);
    setCode("");
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSiteAccess(false);
    setSubmitting(true);
    try {
      await login(email, password);
      forget();
      navigate("/");
    } catch (err) {
      if (err instanceof StaffMfaRequired) {
        remember({ mfaToken: err.mfaToken, email: email.trim(), sentAt: Date.now() });
        return;
      }
      setSiteAccess(isSiteAccessLoginError(err));
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyStaffMfa(pending.mfaToken, { code });
      forget();
      adoptToken(result.token);
      playLoginIntro();
      navigate("/");
    } catch (err) {
      setError(mfaMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    if (!pending || wait > 0) return;
    setError(null);
    setSubmitting(true);
    try {
      await resendStaffSignInCode(pending.mfaToken);
      remember({ ...pending, sentAt: Date.now() });
    } catch (err) {
      setError(mfaMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (pending) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
          <h1 style={{ fontSize: 20, marginBottom: 4 }}>Email sign-in code</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16 }}>
            We emailed a 6-digit code to {pending.email}. It expires in 10 minutes. You can leave this page, copy the code from Mail, and come back.
          </p>
          <form onSubmit={onVerify}>
            <div className="field">
              <label htmlFor="mfa-code">6-digit code</label>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(ev) => setCode(ev.target.value.replace(/\D/g, "").slice(0, 6))} required />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={submitting || code.length !== 6}>{submitting ? "Checking…" : "Continue"}</button>
          </form>
          <p style={{ fontSize: 13, marginTop: 12, textAlign: "center" }}>
            <button type="button" className="btn btn-secondary" disabled={submitting || wait > 0} onClick={onResend}>{wait > 0 ? `Resend code (${wait}s)` : "Resend code"}</button>
          </p>
          <p style={{ fontSize: 13, marginTop: 12, textAlign: "center" }}>
            <button type="button" className="btn btn-secondary" onClick={forget}>Back to password</button>
          </p>
        </div>
      </div>
    );
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
          {error && siteAccess && renewalUrl && <a className="btn btn-primary" href={renewalUrl}>Renew private site access</a>}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>
        <p style={{ fontSize: 13, marginTop: 12, textAlign: "center" }}>
          <Link to="/forgot-password">Forgot password?</Link>
        </p>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 16, textAlign: "center" }}>
          Need access? Ask your administrator for an invite.
        </p>
        {renewalUrl && <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8, textAlign: "center" }}><a href={renewalUrl}>Renew private site access</a> if this private preview asks for access again.</p>}
      </div>
    </div>
  );
}
