import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { acceptInvite, previewInvite, passwordErrorMessage, PASSWORD_RULE } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { readInviteToken } from "../lib/teamUi";

// M5: public page where an invitee chooses their own password.
export function AcceptInvitePage() {
  const navigate = useNavigate();
  const { adoptToken } = useAuth();
  const [token] = useState(() => readInviteToken(typeof window !== "undefined" ? window.location.hash : ""));
  const [invite, setInvite] = useState<{ email: string; full_name: string; organization_name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Drop the token from the address bar and history as soon as it has been read.
    if (typeof window !== "undefined" && window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!token) { setError(passwordErrorMessage("invite_invalid_or_expired")); return; }
    previewInvite(token).then(setInvite).catch((err) => setError(passwordErrorMessage(err?.message)));
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("The passwords don't match."); return; }
    setSaving(true);
    try {
      const res = await acceptInvite(token as string, password);
      adoptToken(res.token);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(passwordErrorMessage(err?.message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Accept your invite</h1>
        {invite && (
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 24 }}>
            Join {invite.organization_name} as {invite.full_name} ({invite.email}). Choose a password to finish.
          </p>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        {invite && (
          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="ai-password">Password</label>
              <input id="ai-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={72} required />
              <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{PASSWORD_RULE}</p>
            </div>
            <div className="field">
              <label htmlFor="ai-confirm">Confirm password</label>
              <input id="ai-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Creating account..." : "Create my account"}</button>
          </form>
        )}
      </div>
    </div>
  );
}