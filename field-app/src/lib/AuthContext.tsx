import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, decodeTokenPayload } from "./api";
import { saveAuth, loadAuth, clearAuth } from "./db";

interface AuthState {
  token: string;
  userId: string;
  organizationId: string;
  role: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAuth().then((stored) => {
      if (stored) setAuth({ token: stored.token, userId: stored.userId, organizationId: stored.organizationId, role: stored.role });
      setLoading(false);
    });
  }, []);

  async function login(email: string, password: string) {
    const { token } = await apiLogin(email, password);
    const { userId, organizationId, role } = decodeTokenPayload(token);
    const next = { token, userId, organizationId, role };
    await saveAuth(next);
    setAuth(next);
  }

  async function logout() {
    await clearAuth();
    setAuth(null);
  }

  return (
    <AuthContext.Provider value={{ auth, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
