import { useEffect, useState } from "react";
import { onSyncStateChange, refreshPendingCount } from "../lib/sync";
import { useAuth } from "../lib/AuthContext";
import type { SyncState } from "../lib/sync";
import { Link } from "react-router-dom";

export function SyncBadge() {
  const { auth, loading, identityChecking } = useAuth();
  const [online, setOnline] = useState(navigator.onLine);
  const [syncState, setSyncState] = useState<SyncState>({ pending: 0, syncing: false, failed: 0, conflicts: 0 });

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    const unsubscribe = onSyncStateChange(setSyncState);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      unsubscribe();
    };
  }, []);

  useEffect(() => { void refreshPendingCount(); }, [auth?.userId, auth?.organizationId]);
  useEffect(() => {
    const retry = () => { if (document.visibilityState === "visible") void refreshPendingCount(); };
    document.addEventListener("visibilitychange", retry);
    window.addEventListener("focus", retry);
    return () => {
      document.removeEventListener("visibilitychange", retry);
      window.removeEventListener("focus", retry);
    };
  }, []);
  if (loading || identityChecking) return <span className="badge">Checking sync</span>;
  if (!auth) return <span className="badge">Sign in to check pending changes</span>;
  if (syncState.checkFailed) return <Link to="/sync-issues" className="badge badge-offline" title="Open synchronization review" onClick={() => { void refreshPendingCount(); }}>Unable to check pending changes</Link>;
  if (!syncState.checked || syncState.userId !== auth.userId || syncState.organizationId !== auth.organizationId)
    return <span className="badge">Checking sync</span>;

  if (!online) {
    return (
      <span className="badge badge-offline" title="No connection — entries are saved locally">
        Offline{syncState.pending > 0 ? ` · ${syncState.pending} queued` : ""}
      </span>
    );
  }

  if (syncState.syncing) {
    return <span className="badge">Syncing…</span>;
  }

  if (syncState.conflicts > 0) {
    return <Link to="/sync-issues" className="badge badge-offline" title="Saved locally; review is required before synchronization can continue">{syncState.conflicts} conflict{syncState.conflicts === 1 ? "" : "s"}</Link>;
  }

  if (syncState.failed > 0) {
    return <Link to="/sync-issues" className="badge badge-offline" title={syncState.lastError || "Saved on this device; open Synchronization review to choose what happens next"}>{syncState.failed} need{syncState.failed === 1 ? "s" : ""} review{syncState.lastError ? ` — ${syncState.lastError}` : ""}</Link>;
  }

  if (syncState.pending > 0) {
    return (
      <span className="badge badge-offline">
        {syncState.pending} pending sync
        {syncState.lastError ? ` — ${syncState.lastError}` : ""}
      </span>
    );
  }

  return <span className="badge">No pending changes for this account</span>;
}
