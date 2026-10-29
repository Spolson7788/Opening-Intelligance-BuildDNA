import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import {
  createCompanyWithAdmin, createProviderFacility, grantMembership, platformMe, grantStaff, platformFacilities, platformOrganizations, platformOrgUsers, platformProviderRequests, platformProviders,
  platformRecognitionUsage, platformUsageSettings, setSafetyCap, updateUsageSettings, platformStaff, reviewProviderRequest, revokeStaff, setOrganizationParent,
  type PlatformFacility, type PlatformOrganization, type PlatformOrgUser, type PlatformProvider, type PlatformStaffRow, type ProviderRequest, type RecognitionUsageReport, type SafetyCapRow, type UsageSettings,
} from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { filterSort, needsProviderConfirmation, parentChoices, treeLines } from "../lib/staffTools";

type Tab = "facilities" | "providers" | "parents" | "requests" | "companies" | "staff" | "usage";
const err = (e: any) => String(e?.message ?? "request_failed").replace(/_/g, " ");

function SortHead<T>({ label, k, sort, setSort }: { label: string; k: keyof T; sort: { k: keyof T; d: 1 | -1 }; setSort: (s: { k: keyof T; d: 1 | -1 }) => void }) {
  return <th><button type="button" style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
    onClick={() => setSort({ k, d: sort.k === k ? (sort.d === 1 ? -1 : 1) : 1 })}>{label}{sort.k === k ? (sort.d === 1 ? " ▲" : " ▼") : ""}</button></th>;
}

function Facilities({ orgName }: { orgName: (id: string) => string }) {
  const [rows, setRows] = useState<PlatformFacility[]>([]); const [q, setQ] = useState(""); const [e, setE] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: keyof PlatformFacility; d: 1 | -1 }>({ k: "owner_name", d: 1 });
  useEffect(() => { platformFacilities().then(setRows).catch((x) => setE(err(x))); }, []);
  const shown = filterSort(rows, q, ["property_name", "owner_name", "state"], sort.k, sort.d);
  return <section className="panel"><h2>Facilities</h2>{e && <p role="alert">{e}</p>}
    <input aria-label="Search facilities" placeholder="Search" value={q} onChange={(x) => setQ(x.target.value)} />
    <table><thead><tr>{([["Facility", "property_name"], ["Company", "owner_name"], ["State", "state"], ["Buildings", "building_count"], ["Openings", "opening_count"]] as const)
      .map(([l, k]) => <SortHead<PlatformFacility> key={k} label={l} k={k} sort={sort} setSort={setSort} />)}<th>Providers</th></tr></thead>
      <tbody>{shown.map((f) => <tr key={f.property_id}><td>{f.property_name}</td><td>{f.owner_name}</td><td>{f.state ?? ""}</td><td>{f.building_count}</td><td>{f.opening_count}</td>
        <td>{f.active_provider_ids.map(orgName).join(", ")}</td></tr>)}</tbody></table></section>;
}

function Providers({ facilityName }: { facilityName: (id: string) => string }) {
  const [rows, setRows] = useState<PlatformProvider[]>([]); const [q, setQ] = useState(""); const [e, setE] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: keyof PlatformProvider; d: 1 | -1 }>({ k: "provider_name", d: 1 });
  useEffect(() => { platformProviders().then(setRows).catch((x) => setE(err(x))); }, []);
  const shown = filterSort(rows, q, ["provider_name"], sort.k, sort.d);
  return <section className="panel"><h2>Service-provider companies</h2>{e && <p role="alert">{e}</p>}
    <input aria-label="Search providers" placeholder="Search" value={q} onChange={(x) => setQ(x.target.value)} />
    <table><thead><tr><SortHead<PlatformProvider> label="Provider" k="provider_name" sort={sort} setSort={setSort} />
      <SortHead<PlatformProvider> label="Facilities" k="active_facility_count" sort={sort} setSort={setSort} /><th>Assigned facilities</th></tr></thead>
      <tbody>{shown.map((p) => <tr key={p.provider_organization_id}><td>{p.provider_name}</td><td>{p.active_facility_count}</td><td>{p.active_property_ids.map(facilityName).join(", ")}</td></tr>)}</tbody></table>
    <ProviderOwnFacility providers={rows} /></section>;
}

// A provider's own facility for openings not tied to a customer facility. Only that provider sees it,
// and its openings are billed once, to the provider.
function ProviderOwnFacility({ providers }: { providers: PlatformProvider[] }) {
  const [pid, setPid] = useState(""); const [name, setName] = useState(""); const [reason, setReason] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  async function create() {
    if (!pid || !name.trim() || !reason.trim()) { setMsg("Choose a provider, a facility name and a reason."); return; }
    setMsg(null);
    try { const r = await createProviderFacility(pid, name.trim(), reason.trim()); setMsg(`Created ${r.facility.name}.`); setName(""); setReason(""); }
    catch (x) { setMsg(err(x)); }
  }
  return <><h2>Create a provider's own facility</h2>
    <p className="muted">For openings not tied to a customer facility. Only that provider sees it; its openings are billed once, to the provider.</p>
    <select aria-label="Provider for own facility" value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Choose a provider</option>
      {providers.map((p) => <option key={p.provider_organization_id} value={p.provider_organization_id}>{p.provider_name}</option>)}</select>{" "}
    <input aria-label="Own facility name" placeholder="Facility name" value={name} onChange={(e) => setName(e.target.value)} />{" "}
    <input aria-label="Own facility reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />{" "}
    <button className="btn" onClick={create}>Create facility</button>{msg && <p role="status">{msg}</p>}</>;
}

function Parents({ orgs, reload }: { orgs: PlatformOrganization[]; reload: () => void }) {
  const [orgId, setOrgId] = useState(""); const [parent, setParent] = useState(""); const [reason, setReason] = useState("");
  const [confirmProvider, setConfirmProvider] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const org = orgs.find((o) => o.id === orgId);
  const choices = parentChoices(orgs, orgId);
  const proposed = parent || null;
  const mustConfirm = needsProviderConfirmation(org, proposed);
  async function save() {
    if (!org || !reason.trim()) { setMsg("Choose a company and give a reason."); return; }
    if (mustConfirm && !confirmProvider) { setMsg("Confirm the provider-under-provider link first."); return; }
    setBusy(true); setMsg(null);
    try { await setOrganizationParent(org.id, { parent_organization_id: proposed, reason: reason.trim(), ...(mustConfirm ? { confirm_provider_link: true as const } : {}) });
      setMsg("Saved."); setReason(""); setConfirmProvider(false); reload(); }
    catch (x) { setMsg(err(x)); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>Parent company links</h2>
    <p className="muted">Customer under customer, provider under provider only. Every change needs a reason and is audited.</p>
    <select aria-label="Company" value={orgId} onChange={(e) => { setOrgId(e.target.value); const o = orgs.find((x) => x.id === e.target.value); setParent(o?.parent_organization_id ?? ""); setConfirmProvider(false); }}>
      <option value="">Choose a company…</option>
      {orgs.filter((o) => o.org_type !== "internal").map((o) => <option key={o.id} value={o.id}>{o.name} ({o.org_type === "customer" ? "customer" : "provider"})</option>)}
    </select>{" "}
    {org && <select aria-label="Parent company" value={parent} onChange={(e) => { setParent(e.target.value); setConfirmProvider(false); }}>
      <option value="">No parent (top level)</option>
      {choices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>}{" "}
    {org && <input aria-label="Reason" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
    {mustConfirm && <p><label><input type="checkbox" checked={confirmProvider} onChange={(e) => setConfirmProvider(e.target.checked)} />{" "}
      I confirm: making this provider a branch of another provider lets the parent provider's admins see this provider's assigned work.</label></p>}
    {org && <><h3>Resulting tree</h3><pre aria-label="Resulting tree">{treeLines(orgs, org.id, proposed).join("\n")}</pre>
      <button className="btn" disabled={busy || (mustConfirm && !confirmProvider)} onClick={save}>{proposed ? "Set parent" : "Clear parent"}</button></>}
    {msg && <p role="status">{msg}</p>}
  </section>;
}

function Requests() {
  const [status, setStatus] = useState("pending"); const [rows, setRows] = useState<ProviderRequest[]>([]); const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => platformProviderRequests(status).then(setRows).catch((x) => setMsg(err(x)));
  useEffect(() => { void load(); }, [status]);
  async function decide(r: ProviderRequest, d: "approve" | "decline") {
    const reason = (notes[r.id] ?? "").trim(); if (!reason) { setMsg("A reason is required."); return; }
    try { await reviewProviderRequest(r.id, d, reason); setMsg(d === "approve" ? "Approved; the assignment was updated." : "Declined."); await load(); } catch (x) { setMsg(err(x)); }
  }
  return <section className="panel"><h2>Provider assignment requests</h2>
    <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>{["pending", "approved", "declined", "withdrawn", "all"].map((s) => <option key={s}>{s}</option>)}</select>
    {msg && <p role="status">{msg}</p>}
    <table><thead><tr><th>Facility</th><th>Company</th><th>Provider</th><th>Type</th><th>Reason</th><th>Requested by</th><th>Status</th><th>Decision</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{r.property_name}</td><td>{r.facility_organization_name}</td><td>{r.provider_name}</td><td>{r.action}</td><td>{r.reason}</td>
        <td>{r.requested_by_name} · {new Date(r.requested_at).toLocaleString()}</td><td>{r.status}{r.review_note ? ` (${r.review_note})` : ""}</td>
        <td>{r.status === "pending" && <><input aria-label="Decision reason" placeholder="Reason" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
          <button className="btn" onClick={() => decide(r, "approve")}>Approve</button> <button className="btn btn-secondary" onClick={() => decide(r, "decline")}>Decline</button></>}</td></tr>)}</tbody></table>
  </section>;
}

function Companies({ orgs, reload }: { orgs: PlatformOrganization[]; reload: () => void }) {
  const [f, setF] = useState({ name: "", org_type: "customer" as "customer" | "service_partner", admin_email: "", admin_full_name: "", reason: "" });
  const [ownFacility, setOwnFacility] = useState(true);
  const [created, setCreated] = useState<{ org: string; email: string; password: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [m, setM] = useState({ email: "", role: "viewer", organization_id: "", reason: "" });
  const [usersOf, setUsersOf] = useState(""); const [users, setUsers] = useState<PlatformOrgUser[]>([]);
  useEffect(() => { if (usersOf) platformOrgUsers(usersOf).then(setUsers).catch(() => setUsers([])); else setUsers([]); }, [usersOf]);
  async function create() {
    setMsg(null); setCreated(null);
    try { const r = await createCompanyWithAdmin({ ...f, name: f.name.trim(), reason: f.reason.trim(), ...(f.org_type === "service_partner" && ownFacility ? { create_provider_facility: true } : {}) });
      setCreated({ org: r.organization.name, email: r.admin.email, password: r.temporary_password });
      setF({ name: "", org_type: "customer", admin_email: "", admin_full_name: "", reason: "" }); reload(); }
    catch (x) { setMsg(err(x)); }
  }
  async function grant() {
    setMsg(null);
    try { await grantMembership({ ...m, reason: m.reason.trim() }); setMsg("Membership granted."); setM({ ...m, email: "", reason: "" }); }
    catch (x) { setMsg(err(x)); }
  }
  return <section className="panel"><h2>Create a company and its first admin</h2>
    <p className="muted">The admin gets a one-time temporary password and must change it at first sign-in.</p>
    <input aria-label="Company name" placeholder="Company name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />{" "}
    <select aria-label="Company type" value={f.org_type} onChange={(e) => setF({ ...f, org_type: e.target.value as "customer" | "service_partner" })}>
      <option value="customer">Customer</option><option value="service_partner">Service provider</option></select>{" "}
    <input aria-label="Admin name" placeholder="Admin full name" value={f.admin_full_name} onChange={(e) => setF({ ...f, admin_full_name: e.target.value })} />{" "}
    <input aria-label="Admin email" placeholder="Admin email (company's own account)" value={f.admin_email} onChange={(e) => setF({ ...f, admin_email: e.target.value })} />{" "}
    <input aria-label="Reason" placeholder="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />{" "}
    {f.org_type === "service_partner" && <label><input type="checkbox" checked={ownFacility} onChange={(e) => setOwnFacility(e.target.checked)} /> Also create the provider's own facility</label>}{" "}
    <button className="btn" onClick={create}>Create</button>
    {created && <div role="alert" className="panel" style={{ border: "2px solid #c80" }}>
      <p>Created {created.org}. Temporary password for {created.email} (shown once; it is not stored or shown again):</p>
      <p><code data-testid="temporary-password">{created.password}</code></p>
      <button className="btn btn-secondary" onClick={() => setCreated(null)}>I have handed it over — hide it</button></div>}
    <h2>Grant an additional membership</h2>
    <input aria-label="Person email" placeholder="Existing person's email" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} />{" "}
    <select aria-label="Membership company" value={m.organization_id} onChange={(e) => setM({ ...m, organization_id: e.target.value })}>
      <option value="">Company…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>{" "}
    <select aria-label="Membership role" value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })}>
      {["viewer", "inspector", "technician", "facilities_manager", "admin"].map((r) => <option key={r}>{r}</option>)}</select>{" "}
    <input aria-label="Membership reason" placeholder="Reason" value={m.reason} onChange={(e) => setM({ ...m, reason: e.target.value })} />{" "}
    <button className="btn" disabled={!m.email || !m.organization_id || !m.reason.trim()} onClick={grant}>Grant</button>
    {msg && <p role="status">{msg}</p>}
    <h2>People in a company</h2>
    <select aria-label="Company people" value={usersOf} onChange={(e) => setUsersOf(e.target.value)}><option value="">Company…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
    <table><tbody>{users.map((u) => <tr key={u.id}><td>{u.full_name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.is_active ? "active" : "inactive"}{u.is_home ? " · home" : ""}</td></tr>)}</tbody></table>
  </section>;
}

function Staff({ me }: { me: string | undefined }) {
  const [rows, setRows] = useState<PlatformStaffRow[]>([]); const [email, setEmail] = useState(""); const [reason, setReason] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  const load = () => platformStaff().then(setRows).catch((x) => setMsg(err(x)));
  useEffect(() => { void load(); }, []);
  async function add() { setMsg(null); try { await grantStaff(email.trim(), reason.trim()); setEmail(""); setReason(""); setMsg("Staff access granted."); await load(); } catch (x) { setMsg(err(x)); } }
  async function remove(r: PlatformStaffRow) {
    const why = window.prompt(`Reason for removing ${r.full_name}'s OI staff access?`); if (!why?.trim()) return;
    try { await revokeStaff(r.user_id, why.trim()); setMsg("Staff access removed."); await load(); } catch (x) { setMsg(err(x)); }
  }
  return <section className="panel"><h2>OI staff</h2>
    <p className="muted">Only members of the OI company can be staff. You cannot change your own staff access.</p>
    <input aria-label="Staff email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />{" "}
    <input aria-label="Staff reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />{" "}
    <button className="btn" disabled={!email || !reason.trim()} onClick={add}>Add staff</button>
    {msg && <p role="status">{msg}</p>}
    <table><thead><tr><th>Name</th><th>Email</th><th>Granted</th><th>Status</th><th></th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.user_id}><td>{r.full_name}</td><td>{r.email}</td><td>{new Date(r.granted_at).toLocaleDateString()} · {r.grant_reason}</td>
        <td>{r.revoked_at ? `removed (${r.revoke_reason ?? ""})` : r.active ? "active" : "inactive"}</td>
        <td>{!r.revoked_at && r.user_id !== me && <button className="btn btn-secondary" onClick={() => remove(r)}>Remove</button>}</td></tr>)}</tbody></table></section>;
}

const usd = (n: number | null) => n == null ? "not set" : "$" + n.toFixed(4);
const cents = (n: number) => "$" + (n / 100).toFixed(2);
// OI staff edit of price, recognition cost and safety caps. Each save needs a reason and is audited (old and new values).
export function UsageSettingsEditor({ orgs, onSaved }: { orgs: PlatformOrganization[]; onSaved: () => void }) {
  const [cur, setCur] = useState<UsageSettings | null>(null); const [caps, setCaps] = useState<SafetyCapRow[]>([]);
  const [price, setPrice] = useState(""); const [cost, setCost] = useState(""); const [cap, setCap] = useState(""); const [ratio, setRatio] = useState(""); const [reason, setReason] = useState("");
  const [capOrg, setCapOrg] = useState(""); const [capValue, setCapValue] = useState(""); const [capReason, setCapReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => platformUsageSettings().then((r) => { setCur(r.settings); setCaps(r.caps);
    setPrice((r.settings.opening_price_cents_per_month / 100).toFixed(2)); setCost(r.settings.cost_per_photo_usd == null ? "" : String(r.settings.cost_per_photo_usd));
    setCap(String(r.settings.default_monthly_photo_cap)); setRatio(String(Math.round(r.settings.cap_warning_ratio * 100))); }).catch((x) => setMsg(err(x)));
  useEffect(() => { load(); }, []);
  const save = async () => {
    setMsg(null);
    const cents = Math.round(Number(price) * 100), pct = Number(ratio), def = Number(cap);
    if (!/^\d+(\.\d{1,2})?$/.test(price.trim()) || cents > 100000) return setMsg("Price must be between $0.00 and $1000.00.");
    if (cost.trim() !== "" && (!/^\d+(\.\d{1,6})?$/.test(cost.trim()) || Number(cost) > 100)) return setMsg("Cost per photo must be blank (unknown) or $0 to $100 with up to 6 decimals.");
    if (!Number.isInteger(def) || def < 1 || def > 10000000) return setMsg("Default cap must be a whole number from 1 to 10,000,000.");
    if (!Number.isInteger(pct) || pct < 5 || pct > 100) return setMsg("Warning must be a whole percent from 5 to 100.");
    if (!reason.trim()) return setMsg("A reason is required.");
    try { await updateUsageSettings({ opening_price_cents_per_month: cents, cost_per_photo_usd: cost.trim() === "" ? null : Number(cost), default_monthly_photo_cap: def, cap_warning_ratio: pct / 100, reason: reason.trim() });
      setReason(""); setMsg("Saved and audited."); load(); onSaved(); } catch (x) { setMsg(err(x)); }
  };
  const saveCap = async (remove: boolean) => {
    setMsg(null); const v = Number(capValue);
    if (!capOrg) return setMsg("Choose a company.");
    if (!remove && (!Number.isInteger(v) || v < 1 || v > 10000000)) return setMsg("Cap must be a whole number from 1 to 10,000,000.");
    if (!capReason.trim()) return setMsg("A reason is required.");
    try { await setSafetyCap(capOrg, remove ? null : v, capReason.trim()); setCapReason(""); setCapValue(""); setMsg(remove ? "Override removed (default cap applies). Audited." : "Cap saved and audited."); load(); onSaved(); }
    catch (x) { setMsg(err(x)); }
  };
  const companies = orgs.filter((o) => o.org_type === "customer" || o.org_type === "service_partner");
  return <section className="panel"><h2>Price, recognition cost and safety caps</h2>
    <p className="muted">OI staff only. Every change needs a reason and is recorded with its old and new values.{cur?.updated_reason && <> Last change: {cur.updated_reason}.</>}</p>
    {msg && <p role="status">{msg}</p>}
    <label>Price per billable opening per month ($) <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>{" "}
    <label>OI cost per photo recognized ($, blank = unknown) <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></label>{" "}
    <label>Default monthly photo cap <input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} /></label>{" "}
    <label>Warn at (% of cap) <input inputMode="numeric" value={ratio} onChange={(e) => setRatio(e.target.value)} /></label>{" "}
    <label>Reason <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></label>{" "}
    <button className="btn" onClick={save}>Save settings</button>
    <h3>Company safety caps</h3>
    <table><thead><tr><th>Company</th><th>Monthly photo cap</th><th>Reason</th></tr></thead>
      <tbody>{caps.length === 0 ? <tr><td colSpan={3}>No overrides; every company uses the default cap.</td></tr> : caps.map((c) => <tr key={c.organization_id}><td>{c.organization_name}</td><td>{c.monthly_photo_cap}</td><td>{c.set_reason}</td></tr>)}</tbody></table>
    <label>Company <select value={capOrg} onChange={(e) => setCapOrg(e.target.value)}><option value="">Choose…</option>{companies.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>{" "}
    <label>Cap <input inputMode="numeric" value={capValue} onChange={(e) => setCapValue(e.target.value)} /></label>{" "}
    <label>Reason <input value={capReason} onChange={(e) => setCapReason(e.target.value)} maxLength={500} /></label>{" "}
    <button className="btn" onClick={() => saveCap(false)}>Set cap</button>{" "}
    <button className="btn btn-secondary" onClick={() => saveCap(true)}>Remove override</button>
  </section>;
}

export function RecognitionUsage({ refresh = 0 }: { refresh?: number }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rep, setRep] = useState<RecognitionUsageReport | null>(null); const [e, setE] = useState<string | null>(null);
  useEffect(() => { let live = true; setE(null); platformRecognitionUsage(month).then((r) => { if (live) setRep(r); }).catch((x) => { if (live) { setRep(null); setE(err(x)); } }); return () => { live = false; }; }, [month, refresh]);
  return <section className="panel"><h2>Usage and billing</h2>
    <p>Billing: {rep ? cents(rep.settings.opening_price_cents_per_month) : "$0.75"} per billable opening per month (full month, no proration), whether or not recognition ran. An opening is billable while captured and active; uncaptured placeholders and decommissioned openings do not bill. The facility owner pays for each billable opening (in a month when ownership moves, only the owner at month end pays); each assigned provider pays only for openings billable while it was assigned. A provider's own facility is billed once.</p>
    <p className="muted">OI recognition cost (internal, never billed): {usd(rep?.settings.cost_per_photo_usd ?? null)} per photo, counted for the company that ran it.</p>
    <label>Month <input type="month" value={month} onChange={(ev) => setMonth(ev.target.value)} /></label>
    {e && <p role="alert">{e}</p>}
    {rep && <table><thead><tr><th>Company</th><th>Type</th><th>Own openings</th><th>Provider openings</th><th>Billable openings</th><th>Revenue</th><th>Photos recognized</th><th>Runs</th><th>OI recognition cost</th><th>Margin</th><th>Safety cap used</th></tr></thead>
      <tbody>{rep.companies.map((c) => <tr key={c.organization_id}><td>{c.organization_name}</td><td>{c.org_type}</td><td>{c.owned_openings}</td><td>{c.provider_openings}</td><td>{c.billable_openings}</td><td>{cents(c.revenue_cents)}</td>
        <td>{c.photos_recognized}</td><td>{c.runs}</td><td>{usd(c.oi_recognition_cost_usd)}</td><td>{usd(c.margin_usd)}</td>
        <td>{Math.round(c.cap_used_ratio * 100)}% of {c.safety_cap_photos}{c.cap_warning && <strong role="status"> Near safety cap</strong>}</td></tr>)}</tbody>
      <tfoot><tr><td>Total ({rep.totals.active_openings} active openings)</td><td /><td /><td /><td>{rep.totals.billable_openings}</td><td>{cents(rep.totals.revenue_cents)}</td><td>{rep.totals.photos_recognized}</td><td>{rep.totals.runs}</td><td>{usd(rep.totals.oi_recognition_cost_usd)}</td><td>{usd(rep.totals.margin_usd)}</td><td /></tr></tfoot></table>}
  </section>;
}

export function StaffToolsPage() {
  const { auth } = useAuth();
  const [tab, setTab] = useState<Tab>("facilities");
  const [orgs, setOrgs] = useState<PlatformOrganization[]>([]);
  const [facilities, setFacilities] = useState<PlatformFacility[]>([]);
  const [staff, setStaff] = useState<boolean | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  useEffect(() => { platformMe().then((m) => setStaff(m.staff)); }, []);
  const reload = () => { platformOrganizations().then(setOrgs).catch(() => setOrgs([])); };
  useEffect(() => { if (!staff) return; reload(); platformFacilities().then(setFacilities).catch(() => setFacilities([])); }, [staff]);
  const orgName = useMemo(() => { const m = new Map(orgs.map((o) => [o.id, o.name])); return (id: string) => m.get(id) ?? id; }, [orgs]);
  const facilityName = useMemo(() => { const m = new Map(facilities.map((f) => [f.property_id, `${f.owner_name} / ${f.property_name}`])); return (id: string) => m.get(id) ?? id; }, [facilities]);
  const tabs: [Tab, string][] = [["facilities", "By facility"], ["providers", "By provider"], ["parents", "Parent links"], ["requests", "Provider requests"], ["companies", "Companies & people"], ["staff", "OI staff"], ["usage", "Recognition usage"]];
  if (staff !== true) return <div className="app-shell"><Sidebar /><div className="main">
    <p role="status">{staff === null ? "Checking access…" : "OI staff tools are only available to OI staff."}</p></div></div>;
  return <div className="app-shell"><Sidebar /><div className="main">
    <div className="page-header"><div><h1>OI staff tools</h1><p>Every view and change here is recorded in the audit log.</p></div></div>
    <nav aria-label="Staff tools">{tabs.map(([t, l]) => <button key={t} className={tab === t ? "btn" : "btn btn-secondary"} onClick={() => setTab(t)} style={{ marginRight: 6 }}>{l}</button>)}</nav>
    {tab === "facilities" && <Facilities orgName={orgName} />}
    {tab === "providers" && <Providers facilityName={facilityName} />}
    {tab === "parents" && <Parents orgs={orgs} reload={reload} />}
    {tab === "requests" && <Requests />}
    {tab === "companies" && <Companies orgs={orgs} reload={reload} />}
    {tab === "staff" && <Staff me={auth?.userId} />}
    {tab === "usage" && <><UsageSettingsEditor orgs={orgs} onSaved={() => setUsageRefresh((n) => n + 1)} /><RecognitionUsage refresh={usageRefresh} /></>}
  </div></div>;
}
