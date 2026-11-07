import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { SESSION_EXPIRED_MESSAGE, SESSION_EXPIRED_PARAM } from "../lib/session";
import { loginErrorMessage } from "../lib/scheduleUi";
import { StaffMfaRequired, useAuth } from "../lib/AuthContext";
import { enrollStaffMfa, verifyStaffMfa, type StaffMfaEnrollment } from "../lib/api";
import { isSiteAccessLoginError, siteAccessRenewalUrl, SITE_ACCESS_LOGIN_MESSAGE } from "../lib/siteAccess";
import { playLoginIntro } from "../lib/loginIntro";

function mfaMessage(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  if (code === "mfa_code_reused") return "That code was already used. Wait for the next authenticator code, or use a recovery code.";
  if (code === "mfa_rate_limited") return "Too many attempts. Wait 15 minutes and try again.";
  if (code === "mfa_unavailable") return "Authenticator setup is unavailable right now. Try again shortly.";
  if (code === "invalid_mfa_code") return "That code wasn't accepted. Check the authenticator app and try again.";
  return loginErrorMessage(err);
}

export function LoginPage() {
  const { login, adoptToken } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [siteAccess, setSiteAccess] = useState(false);
  const [challenge, setChallenge] = useState<StaffMfaRequired | null>(null);
  const [enrollment, setEnrollment] = useState<StaffMfaEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [savedCodes, setSavedCodes] = useState(false);
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
      if (err instanceof StaffMfaRequired) {
        setChallenge(err);
        if (err.enrollmentRequired) {
          try { setEnrollment(await enrollStaffMfa(err.mfaToken)); }
          catch (enrollError) { setChallenge(null); setError(mfaMessage(enrollError)); }
        }
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
    if (!challenge) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyStaffMfa(challenge.mfaToken, enrollment || !recovery.trim() ? { code } : { recovery_code: recovery.trim() });
      adoptToken(result.token);
      playLoginIntro();
      navigate("/");
    } catch (err) {
      setError(mfaMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (challenge) {
    const canSubmit = enrollment ? code.length === 6 && savedCodes : (code.length === 6 || recovery.trim().length >= 8);
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
          <h1 style={{ fontSize: 20, marginBottom: 4 }}>Authenticator code</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16 }}>
            Staff sign-in needs the 6-digit code from your authenticator app after your password.
          </p>
          {enrollment && (
            <div>
              <p role="alert"><strong>Shown only once.</strong> {enrollment.warning}</p>
              <img src={enrollment.qr_data_url} alt="Authenticator setup QR code" width={256} height={256} />
              <p>Setup key: <code>{enrollment.secret}</code></p>
              <p>Recovery codes</p>
              <ul>{enrollment.recovery_codes.map((item) => <li key={item}><code>{item}</code></li>)}</ul>
              <label><input type="checkbox" checked={savedCodes} onChange={(ev) => setSavedCodes(ev.target.checked)} /> I have saved these recovery codes</label>
            </div>
          )}
          <form onSubmit={onVerify}>
            <div className="field">
              <label htmlFor="mfa-code">6-digit code</label>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(ev) => setCode(ev.target.value.replace(/\D/g, "").slice(0, 6))} required={!recovery.trim()} />
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
          <p style={{ fontSize: 13, marginTop: 12, textAlign: "center" }}>
            <button type="button" className="btn btn-secondary" onClick={() => { setChallenge(null); setEnrollment(null); setCode(""); setRecovery(""); setSavedCodes(false); }}>Back to password</button>
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
          {error && siteAccess && renewalUrl && <a className="btn btn-primary" href={renewalUrl} target="_blank" rel="noreferrer">Renew private site access</a>}
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
        {renewalUrl && <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8, textAlign: "center" }}><a href={renewalUrl} target="_blank" rel="noreferrer">Renew private site access</a> if this private preview asks for access again.</p>}
      </div>
    </div>
  );
}
