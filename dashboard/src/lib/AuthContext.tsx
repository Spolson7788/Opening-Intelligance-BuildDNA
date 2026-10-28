import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, signup as apiSignup, setToken, decodeTokenPayload } from "./api";
import { readValidToken } from "./session";

interface AuthState {
  userId: string;
  organizationId: string;
  role: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (payload: { organization_name: string; email: string; password: string; full_name: string }) => Promise<void>;
  logout: () => void;
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
  }

  async function signup(payload: { organization_name: string; email: string; password: string; full_name: string }) {
    const { token } = await apiSignup(payload);
    setToken(token);
    setAuth(decodeTokenPayload(token));
  }

  function logout() {
    setToken(null);
    setAuth(null);
  }

  return <AuthContext.Provider value={{ auth, login, signup, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
