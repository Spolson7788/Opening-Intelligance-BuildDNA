import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, setToken, decodeTokenPayload, ApiError } from "./api";
import { readValidToken } from "./session";
import { playLoginIntro } from "./loginIntro";

/** Password was accepted for a staff account. The authenticator step is still required. */
export class StaffMfaRequired extends Error {
  readonly mfaToken: string;
  readonly enrollmentRequired: boolean;
  constructor(mfaToken: string, enrollmentRequired: boolean) {
    super("mfa_required");
    this.name = "StaffMfaRequired";
    this.mfaToken = mfaToken;
    this.enrollmentRequired = enrollmentRequired;
  }
}

interface AuthState {
  userId: string;
  organizationId: string;
  role: string;
  mustChangePassword: boolean;
}

interface AuthContextValue {
  auth: AuthState | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** M5: adopt a token issued by change-password or invite acceptance. */
  adoptToken: (token: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readInitialAuth(): AuthState | null {
  // Drop an expired token before any request is made.
  const token = readValidToken(typeof localStorage !== "undefined" ? localStorage : null);
  if (!token) return null;
  try {
    return decodeTokenPayload(token);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(readInitialAuth);

  async function login(email: string, password: string) {
    const body = await apiLogin(email, password);
    if (body.mfa_required) {
      if (!body.mfa_token) throw new ApiError(503, "mfa_unavailable");
      throw new StaffMfaRequired(body.mfa_token, body.enrollment_required === true);
    }
    if (!body.token) throw new ApiError(503, "authentication_service_unavailable");
    setToken(body.token);
    setAuth(decodeTokenPayload(body.token));
    // Fresh interactive sign-in only (never on reload/session restore).
    playLoginIntro();
  }

  function adoptToken(token: string) {
    setToken(token);
    setAuth(decodeTokenPayload(token));
  }

  function logout() {
    setToken(null);
    setAuth(null);
  }

  return <AuthContext.Provider value={{ auth, login, logout, adoptToken }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
