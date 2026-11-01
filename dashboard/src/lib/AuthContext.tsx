import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, setToken, decodeTokenPayload } from "./api";
import { readValidToken } from "./session";
import { playLoginIntro } from "./loginIntro";

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
    const { token } = await apiLogin(email, password);
    setToken(token);
    setAuth(decodeTokenPayload(token));
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
