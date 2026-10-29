import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { type Property, type ProviderRequest, myProviderRequests, providerRequestOptions, requestProvider, withdrawProviderRequest } from "../lib/api";
import { canManageProviderSharing } from "./ProviderHistorySharingToggle";

/** M5: facility admins ask OI staff to assign or unassign a service provider. OI staff decide. */
export function RequestProviderPanel({ property, role }: { property: Property | undefined; role: string | undefined }) {
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [requests, setRequests] = useState<ProviderRequest[]>([]);
  const [providerId, setProviderId] = useState("");
  const [action, setAction] = useState<"assign" | "unassign">("assign");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const allowed = !!property && canManageProviderSharing(role, property);
  async function load() {
    if (!property) return;
    try {
      const o = await providerRequestOptions();
      setProviders(o.providers); setAssigned(o.assigned.filter((a) => a.property_id === property.id).map((a) => a.provider_organization_id));
      setRequests((await myProviderRequests()).filter((r) => r.property_id === property.id));
    } catch { setMsg("Could not load provider requests."); }
  }
  useEffect(() => { if (allowed) void load(); }, [property?.id, allowed]);
  if (!allowed || !property) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!providerId || !reason.trim()) { setMsg("Choose a provider and give a reason."); return; }
    setBusy(true); setMsg(null);
    try { await requestProvider({ property_id: property!.id, provider_organization_id: providerId, action, reason: reason.trim() }); setReason(""); setMsg("Request sent to OI staff."); await load(); }
    catch (err: any) { setMsg(err?.message === "request_already_pending" ? "A request for this provider is already pending." : "The request could not be sent."); }
    finally { setBusy(false); }
  }
  async function withdraw(id: string) {
    setBusy(true);
    try { await withdrawProviderRequest(id); await load(); } catch { setMsg("Could not withdraw the request."); } finally { setBusy(false); }
  }
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  return <div className="panel" aria-label="Request a service provider">
    <h3>Service providers</h3>
    <p className="muted">Assigned: {assigned.length ? assigned.map(name).join(", ") : "none"}. OI staff review every change.</p>
    <form onSubmit={submit}>
      <select aria-label="Request type" value={action} onChange={(e) => setAction(e.target.value as "assign" | "unassign")}>
        <option value="assign">Request provider</option><option value="unassign">Request removal</option>
      </select>{" "}
      <select aria-label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
        <option value="">Choose a provider…</option>
        {(action === "unassign" ? providers.filter((p) => assigned.includes(p.id)) : providers).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>{" "}
      <input aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />{" "}
      <button className="btn" disabled={busy}>Send request</button>
    </form>
    {msg && <p role="status">{msg}</p>}
    {requests.length > 0 && <table><thead><tr><th>Provider</th><th>Type</th><th>Status</th><th>Requested</th><th>Note</th><th></th></tr></thead><tbody>
      {requests.map((r) => <tr key={r.id}><td>{r.provider_name}</td><td>{r.action}</td><td>{r.status}</td><td>{new Date(r.requested_at).toLocaleString()}</td><td>{r.review_note ?? ""}</td>
        <td>{r.status === "pending" && <button className="btn btn-secondary" disabled={busy} onClick={() => withdraw(r.id)}>Withdraw</button>}</td></tr>)}
    </tbody></table>}
  </div>;
}
