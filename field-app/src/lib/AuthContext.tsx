import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, decodeTokenPayload, requestCompanySwitch } from "./api";
import { decideSwitch, pendingWorkFor } from "./companySwitch";
import type { SwitchDecision } from "./companySwitch";
import { loadAuth, clearAuth } from "./db";
import { recordFreshSignIn } from "./freshSignIn";
import { playLoginIntro } from "./loginIntro";

interface AuthState {
  token: string;
  userId: string;
  organizationId: string;
  role: string;
  email?: string;
  /** M5: from the token claim; the server enforces it. */
  mustChangePassword?: boolean;
}

interface AuthContextValue {
  auth: AuthState | null;
  loading: boolean;
  identityChecking: boolean;
  logoutPending: boolean;
  logoutError: string | null;
  login: (email: string, password: string, resumeQueued?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  /** M4: never discards work; blocked while uploading, needs confirmation with unsynced work. */
  switchCompany: (organizationId: string, acknowledgeUnsynced: boolean) => Promise<SwitchResult>;
}
export type SwitchResult = SwitchDecision | { kind: "switched" } | { kind: "failed"; message: string };

/** M5: UI hint only (the API enforces it). Local so it never depends on the api module. */
function tokenRequiresPasswordChange(token: string | null | undefined): boolean {
  try { return !!token && JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).mustChangePassword === true; } catch { return false; }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [identityChecking, setIdentityChecking] = useState(true);
  const revision = useRef(0);
  const changing = useRef(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function reconcile() {
      if (changing.current) return;
      const read = ++revision.current;
      try {
        const stored = await loadAuth();
        if (!active || read !== revision.current || changing.current) return;
        const next = stored ? { token: stored.token, userId: stored.userId, organizationId: stored.organizationId, role: stored.role, email: stored.email, mustChangePassword: tokenRequiresPasswordChange(stored.token) } : null;
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

  async function login(email: string, password: string, resumeQueued = true) {
    changing.current = true; ++revision.current; setLoading(true);
    try {
    const { token } = await apiLogin(email, password);
    const { userId, organizationId, role } = decodeTokenPayload(token);
    // Display only; authorization continues to use the server-issued principal.
    const next = { token, userId, organizationId, role, email: email.trim() };
    await recordFreshSignIn(next, resumeQueued, resumeQueued);
    setAuth({ ...next, mustChangePassword: tokenRequiresPasswordChange(token) });
    // Fresh interactive sign-in only (never on reload, session restore, or company switch).
    playLoginIntro();
    } finally { changing.current = false; setLoading(false); setIdentityChecking(false); }
  }

  async function logout() {
    // Synchronous guard also covers clicks before React renders the disabled button.
    if (changing.current) return;
    changing.current = true; ++revision.current;
    setLogoutPending(true); setLogoutError(null);
    try { await clearAuth(); setAuth(null); }
    catch { setLogoutError("Sign-out could not be completed. Your saved changes remain on this device. Stay offline if you are switching accounts with pending changes."); }
    finally { changing.current = false; setLogoutPending(false); setIdentityChecking(false); }
  }

  async function switchCompany(organizationId: string, acknowledgeUnsynced: boolean): Promise<SwitchResult> {
    if (changing.current || !auth) return { kind: "failed", message: "Please wait and try again." };
    const current = { userId: auth.userId, organizationId: auth.organizationId };
    const decision = decideSwitch(current, organizationId, await pendingWorkFor(current), acknowledgeUnsynced);
    if (decision.kind !== "allowed") return decision;
    changing.current = true; ++revision.current;
    try {
      const { token } = await requestCompanySwitch(organizationId);
      const p = decodeTokenPayload(token);
      if (p.userId !== auth.userId || p.organizationId !== organizationId) return { kind: "failed", message: "The company could not be switched." };
      const next = { token, userId: p.userId, organizationId: p.organizationId, role: p.role, email: auth.email };
      // A new sign-in event for the target company: its own stopped work resumes; nothing else changes.
      await recordFreshSignIn(next, true, true);
      setAuth({ ...next, mustChangePassword: tokenRequiresPasswordChange(token) });
      return { kind: "switched" };
    } catch {
      return { kind: "failed", message: "The company could not be switched. Your saved work remains on this device." };
    } finally { changing.current = false; }
  }

  return (
    <AuthContext.Provider value={{ auth, loading, identityChecking, logoutPending, logoutError, login, logout, switchCompany }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
