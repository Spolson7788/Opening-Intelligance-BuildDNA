import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { StaffMfaRequired, useAuth } from "../lib/AuthContext";
import { ApiError, resendStaffSignInCode, verifyStaffMfa } from "../lib/api";
import { clearPendingStaffSignIn, readPendingStaffSignIn, savePendingStaffSignIn, type PendingStaffSignIn } from "../lib/staffSignInPending";
import { readLoginForm } from "../lib/loginForm";
import { loginFailureMessage } from "../lib/authResponse";
import { loginReturnPath } from "../lib/qrPayload";
import { isQrDetailsPath } from '../lib/qrLanding';
import { siteAccessRenewalUrl } from '../lib/siteAccess';
import { RenewPrivateSiteAccess } from '../components/RenewPrivateSiteAccess';
import { isSiteAccessLoginFailure } from '../lib/authResponse';

function mfaMessage(code: string): string {
  if (code === "mfa_code_reused") return "That code was already used. Send a new one.";
  if (code === "mfa_code_expired") return "That code expired. Send a new one.";
  if (code === "mfa_rate_limited") return "Too many attempts. Wait 15 minutes, or ask another staff member to clear the lockout.";
  if (code === "resend_cooldown") return "Wait about a minute before sending another code.";
  if (code === "mfa_unavailable") return "The sign-in code could not be emailed. Try again shortly.";
  if (code === "invalid_mfa_code") return "That code wasn't accepted. Check the email and try again.";
  return "The sign-in code could not be checked. Try again.";
}

function browserSession(): Storage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

export function LoginPage() {
  const { auth, loading, identityChecking, login, finishStaffSignIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingStaffSignIn | null>(() => readPendingStaffSignIn(browserSession()));
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // Same allow-listed builder as the opening detail and QR pages; null on any other origin.
  const renewalUrl = siteAccessRenewalUrl(window.location.origin);
  const wait = pending ? Math.max(0, 60 - Math.floor((now - pending.sentAt) / 1000)) : 0;

  useEffect(() => { setError(null); setReference(null); }, [auth?.userId, auth?.organizationId]);
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
      forget();
      const from = location.state?.from;
      navigate(loginReturnPath(from), { replace: true });
    } catch (err) {
      if (err instanceof StaffMfaRequired) {
        remember({ mfaToken: err.mfaToken, email: credentials.email, sentAt: Date.now() });
        return;
      }
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

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pending || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyStaffMfa(pending.mfaToken, { code });
      const resumeQueued = !isQrDetailsPath(location.state?.from);
      forget();
      await finishStaffSignIn(result.token, pending.email, resumeQueued);
      navigate(loginReturnPath(location.state?.from), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? mfaMessage(err.message) : "The sign-in code could not be checked. Try again.");
    } finally { setSubmitting(false); }
  }

  async function onResend() {
    if (!pending || wait > 0 || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await resendStaffSignInCode(pending.mfaToken);
      remember({ ...pending, sentAt: Date.now() });
    } catch (err) {
      setError(err instanceof ApiError ? mfaMessage(err.message) : "The sign-in code could not be emailed. Try again shortly.");
    } finally { setSubmitting(false); }
  }

  if (pending) {
    return (
      <div className="app-shell c04"><div className="screen">
        <p className="c04-kicker">Field app</p>
        <h1>Email sign-in code</h1>
        <section className="c04-band">
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>We emailed a 6-digit code to {pending.email}. It expires in 10 minutes. You can switch to Mail, copy the code, and come back to this screen.</p>
        <form onSubmit={onVerify}>
          <div className="field">
            <label htmlFor="mfa-code">6-digit code</label>
            <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value.replace(/\D/g, "").slice(0, 6))} />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={submitting || code.length !== 6}>{submitting ? "Checking…" : "Continue"}</button>
        </form>
        <button type="button" className="btn" disabled={submitting || wait > 0} onClick={onResend}>{wait > 0 ? `Resend code (${wait}s)` : "Resend code"}</button>
        <button type="button" className="btn c04-choice" onClick={forget}>Back to password</button>
        </section>
      </div></div>
    );
  }

  if (loading || identityChecking) return <div className="screen"><p role="status">Checking signed-in account.</p></div>;
  if (auth) return <div className="app-shell c04"><div className="screen">
    <p className="c04-kicker">Field app</p>
    <h1>Already signed in</h1>
    <p>Signed in as {auth.email || `Account ${auth.userId}`}</p>
    <p>Organization {auth.organizationId}</p>
    <p>This sign-in page does not switch accounts. To use a different account, go to Scan and sign out first. Saved changes remain associated with their original account.</p>
    <button type="button" className="btn btn-primary" onClick={() => navigate(loginReturnPath(location.state?.from), { replace: true })}>Continue with this account</button>
    <button type="button" className="btn c04-choice" onClick={() => navigate("/scan", { replace: true })}>Go to Scan</button>
  </div></div>;

  return (
    <div className="app-shell c04"><div className="screen">
      <p className="c04-kicker">Field app</p>
      <h1>Field Sign-In</h1>
      <p className="c04-note">Sign in to scan openings and log service.</p>
      <section className="c04-band">
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
        {error && isSiteAccessLoginFailure(error) && renewalUrl && <RenewPrivateSiteAccess className="btn btn-primary">Renew private site access</RenewPrivateSiteAccess>}
        {reference && <p>Support reference: {reference}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
      </section>
      <p style={{ textAlign: "center", marginTop: 16 }}>
        <Link to="/forgot-password">Forgot password?</Link>
        {" · "}
        <Link to="/how-to-use">How to use</Link>
      </p>
      {renewalUrl && <p style={{ fontSize: 16, marginTop: 16 }}><RenewPrivateSiteAccess>Renew private site access</RenewPrivateSiteAccess> if this private preview asks for access again.</p>}
    </div></div>
  );
}
