import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [organizationName, setOrganizationName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signup({ organization_name: organizationName, email, password, full_name: fullName });
      navigate("/");
    } catch (err: any) {
      setError(err?.message === "email_already_registered" ? "That email is already in use." : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card" style={{ width: 380 }}>
        <div className="asset-plate" style={{ marginBottom: 18 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Create Your Organization</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 24 }}>
          Sets up your portfolio and your first admin account.
        </p>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="org-name">Organization name</label>
            <input id="org-name" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} placeholder="e.g. Acme Facilities" required />
          </div>
          <div className="field">
            <label htmlFor="full-name">Your name</label>
            <input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create Organization"}
          </button>
        </form>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 16, textAlign: "center" }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
