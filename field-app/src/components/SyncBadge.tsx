import { useEffect, useState } from "react";
import { onSyncStateChange } from "../lib/sync";
import type { SyncState } from "../lib/sync";

export function SyncBadge() {
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
    return <span className="badge badge-offline" title="Saved locally; review is required before synchronization can continue">{syncState.conflicts} conflict{syncState.conflicts === 1 ? "" : "s"}</span>;
  }

  if (syncState.failed > 0) {
    return <span className="badge badge-offline" title="Saved locally; synchronization will retry">{syncState.failed} retrying</span>;
  }

  if (syncState.pending > 0) {
    return <span className="badge badge-offline">{syncState.pending} pending sync</span>;
  }

  return <span className="badge" style={{ color: "var(--success)", borderColor: "var(--success)" }}>Synced</span>;
}
