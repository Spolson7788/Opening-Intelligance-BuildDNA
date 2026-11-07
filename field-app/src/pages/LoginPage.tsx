import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { StaffMfaRequired, useAuth } from "../lib/AuthContext";
import { ApiError, enrollStaffMfa, verifyStaffMfa } from "../lib/api";
import type { StaffMfaEnrollment } from "../lib/api";
import { readLoginForm } from "../lib/loginForm";
import { loginFailureMessage } from "../lib/authResponse";
import { loginReturnPath } from "../lib/qrPayload";
import { isQrDetailsPath } from '../lib/qrLanding';
import { siteAccessRenewalUrl } from '../lib/siteAccess';
import { isSiteAccessLoginFailure } from '../lib/authResponse';

function mfaMessage(code: string): string {
  if (code === "mfa_code_reused") return "That code was already used. Wait for the next authenticator code, or use a recovery code.";
  if (code === "mfa_rate_limited") return "Too many attempts. Wait 15 minutes and try again.";
  if (code === "mfa_unavailable") return "Authenticator setup is unavailable right now. Try again shortly.";
  if (code === "invalid_mfa_code") return "That code wasn't accepted. Check the authenticator app and try again.";
  return "The authenticator code could not be checked. Try again.";
}

export function LoginPage() {
  const { auth, loading, identityChecking, login, finishStaffSignIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [challenge, setChallenge] = useState<StaffMfaRequired | null>(null);
  const [enrollment, setEnrollment] = useState<StaffMfaEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [savedCodes, setSavedCodes] = useState(false);
  const [staffEmail, setStaffEmail] = useState("");
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
      if (err instanceof StaffMfaRequired) {
        setStaffEmail(credentials.email);
        setChallenge(err);
        if (err.enrollmentRequired) {
          try { setEnrollment(await enrollStaffMfa(err.mfaToken)); }
          catch (enrollError) {
            setChallenge(null);
            setError(enrollError instanceof ApiError ? mfaMessage(enrollError.message) : "Authenticator setup is unavailable right now. Try again shortly.");
          }
        }
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
    if (!challenge || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyStaffMfa(challenge.mfaToken, enrollment || !recovery.trim() ? { code } : { recovery_code: recovery.trim() });
      const resumeQueued = !isQrDetailsPath(location.state?.from);
      await finishStaffSignIn(result.token, staffEmail, resumeQueued);
      navigate(loginReturnPath(location.state?.from), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? mfaMessage(err.message) : "The authenticator code could not be checked. Try again.");
    } finally { setSubmitting(false); }
  }

  if (challenge) {
    const canSubmit = enrollment ? code.length === 6 && savedCodes : (code.length === 6 || recovery.trim().length >= 8);
    return (
      <div className="screen" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "100vh" }}>
        <div className="asset-plate" style={{ marginBottom: 16 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Authenticator code</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>Staff sign-in needs the 6-digit code from your authenticator app. You need a network connection for this step.</p>
        {enrollment && (
          <div>
            <p role="alert"><strong>Shown only once.</strong> {enrollment.warning}</p>
            <img src={enrollment.qr_data_url} alt="Authenticator setup QR code" width={256} height={256} />
            <p>Setup key: <code>{enrollment.secret}</code></p>
            <ul>{enrollment.recovery_codes.map((item) => <li key={item}><code>{item}</code></li>)}</ul>
            <label><input type="checkbox" checked={savedCodes} onChange={(ev) => setSavedCodes(ev.target.checked)} /> I have saved these recovery codes</label>
          </div>
        )}
        <form onSubmit={onVerify}>
          <div className="field">
            <label htmlFor="mfa-code">6-digit code</label>
            <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value.replace(/\D/g, "").slice(0, 6))} />
          </div>
          {!enrollment && (
            <div className="field">
              <label htmlFor="recovery-code">Recovery code</label>
              <input id="recovery-code" autoComplete="off" value={recovery} onChange={(ev) => setRecovery(ev.target.value)} />
            </div>
          )}
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit}>{submitting ? "Checking…" : "Continue"}</button>
        </form>
        <button type="button" className="btn" onClick={() => { setChallenge(null); setEnrollment(null); setCode(""); setRecovery(""); setSavedCodes(false); }}>Back to password</button>
      </div>
    );
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
