import { useEffect, useState } from "react";
import { type Property, setProviderHistorySharing } from "../lib/api";

/** Only the facility owner's admin may change provider history sharing. */
export function canManageProviderSharing(role: string | undefined, property: Pick<Property, "is_owner"> | undefined): boolean {
  return role === "admin" && property?.is_owner === true;
}

export function ProviderHistorySharingToggle({ property, role, onChanged }: { property: Property | undefined; role: string | undefined; onChanged?: (enabled: boolean) => void }) {
  const [enabled, setEnabled] = useState(property?.share_provider_service_history === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setEnabled(property?.share_provider_service_history === true); setError(null); }, [property?.id, property?.share_provider_service_history]);
  if (!property || !canManageProviderSharing(role, property)) return null;
  async function toggle(next: boolean) {
    if (!property) return;
    setBusy(true); setError(null);
    try { const r = await setProviderHistorySharing(property.id, next); setEnabled(r.share_provider_service_history); onChanged?.(r.share_provider_service_history); }
    catch { setError("Could not change the sharing setting. Try again later."); }
    finally { setBusy(false); }
  }
  return (
    <div className="provider-sharing" aria-label="Provider history sharing">
      <label>
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />{" "}
        Let service providers at this facility see each other's service history
      </label>
      <p className="muted">{enabled ? "On: assigned providers see all service history here." : "Off (default): each provider sees only its own work. You always see everything."}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
