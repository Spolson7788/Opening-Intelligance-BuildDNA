import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { ApiError } from "../lib/api";
import { readLoginForm } from "../lib/loginForm";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read the actual form before any re-render. Autofill/password managers
    // can update native inputs without firing React onChange.
    const credentials = readLoginForm(new FormData(e.currentTarget));
    setError(null);
    setReference(null);
    setSubmitting(true);
    try {
      await login(credentials.email, credentials.password);
      const from = location.state?.from;
      navigate(typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && from !== "/login" ? from : "/scan", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setReference(err.reference || null);
      if (err instanceof ApiError && err.status === 401) {
        setError("Email or password didn't match. Try again.");
      } else if (err instanceof ApiError && err.status === 403) {
        setError("This account is deactivated. Contact an administrator.");
      } else {
        setError("Sign-in service is unavailable. Your credentials were not rejected; try again shortly.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="screen" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "100vh" }}>
      <div style={{ marginBottom: 32 }}>
        <div className="asset-plate" style={{ marginBottom: 16 }}>OPENING-INTEL</div>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Field Sign-In</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
          Sign in to scan openings and log service.
        </p>
      </div>
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
        {reference && <p>Support reference: {reference}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}
