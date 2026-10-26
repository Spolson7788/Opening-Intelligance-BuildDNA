import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, decodeTokenPayload } from "./api";
import { loadAuth, clearAuth } from "./db";
import { recordFreshSignIn } from "./freshSignIn";

interface AuthState {
  token: string;
  userId: string;
  organizationId: string;
  role: string;
  email?: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  loading: boolean;
  identityChecking: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [identityChecking, setIdentityChecking] = useState(true);
  const revision = useRef(0);
  const changing = useRef(false);

  useEffect(() => {
    let active = true;
    async function reconcile() {
      if (changing.current) return;
      const read = ++revision.current;
      try {
        const stored = await loadAuth();
        if (!active || read !== revision.current || changing.current) return;
        const next = stored ? { token: stored.token, userId: stored.userId, organizationId: stored.organizationId, role: stored.role, email: stored.email } : null;
        setAuth(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setLoading(false);
        setIdentityChecking(false);
      } catch {
        if (active && read === revision.current) setIdentityChecking(true);
      }
    }
    void reconcile();
    // IndexedDB is shared between tabs; polling never requeues work or creates a fresh sign-in.
    const timer = window.setInterval(() => { void reconcile(); }, 1500);
    const focus = () => { setIdentityChecking(true); void reconcile(); };
    window.addEventListener("focus", focus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, []);

  async function login(email: string, password: string) {
    changing.current = true; ++revision.current; setLoading(true);
    try {
    const { token } = await apiLogin(email, password);
    const { userId, organizationId, role } = decodeTokenPayload(token);
    // Display only; authorization continues to use the server-issued principal.
    const next = { token, userId, organizationId, role, email: email.trim() };
    await recordFreshSignIn(next);
    setAuth(next);
    } finally { changing.current = false; setLoading(false); setIdentityChecking(false); }
  }

  async function logout() {
    changing.current = true; ++revision.current; setLoading(true);
    try { await clearAuth(); setAuth(null); }
    finally { changing.current = false; setLoading(false); setIdentityChecking(false); }
  }

  return (
    <AuthContext.Provider value={{ auth, loading, identityChecking, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
