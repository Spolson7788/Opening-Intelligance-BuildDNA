import { useAuth } from "../lib/AuthContext";

export function AccountIdentity() {
  const { auth, loading, identityChecking } = useAuth();
  if (loading || identityChecking || !auth) return null;
  return <aside aria-label="Current account" style={{ padding: "8px 16px", overflowWrap: "anywhere" }}>
    Signed in as {auth.email || `Account ${auth.userId}`} · Organization {auth.organizationId}
  </aside>;
}
