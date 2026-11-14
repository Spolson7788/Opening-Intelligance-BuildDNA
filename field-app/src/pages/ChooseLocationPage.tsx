import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { listFieldProperties } from "../lib/api";
import { getOfflineSetting, putOfflineSetting } from "../lib/db";
import { selectedFacilityKey } from "../lib/facilitySync";
import type { FacilityProperty } from "../lib/facilityOpenings";
import { useFacilitySync } from "../components/FacilitySelector";
import {
  countiesFrom, describeLocation, facilitiesFrom, initialDraft, keyFromOption, narrowDraft, optionValue,
  statesFrom, writeLocationConfirmation, type LocationDraft,
} from "../lib/locationChoice";

export function ChooseLocationPage() {
  const { auth, logout, logoutPending } = useAuth();
  const sync = useFacilitySync();
  const navigate = useNavigate();
  const [list, setList] = useState<FacilityProperty[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<LocationDraft>({ stateKey: null, countyKey: null, facilityId: "" });
  const [preferred, setPreferred] = useState<string | null>(null);
  const [changing, setChanging] = useState(true);
  const [facilityHint, setFacilityHint] = useState("");
  const principal = auth ? { userId: auth.userId, organizationId: auth.organizationId } : null;

  useEffect(() => {
    if (!principal) return;
    let live = true;
    const owner = principal;
    (async () => {
      setError("");
      let facilities: FacilityProperty[] | null = null;
      let usedCache = false;
      try {
        facilities = await listFieldProperties();
        await putOfflineSetting({ key: `facilities:${owner.userId}:${owner.organizationId}`, value: facilities, updatedAt: new Date().toISOString() });
      } catch {
        const cached = await getOfflineSetting(`facilities:${owner.userId}:${owner.organizationId}`).catch(() => null);
        facilities = (cached?.value as FacilityProperty[]) ?? null;
        usedCache = !!facilities;
        if (!facilities) setError("Facilities could not be loaded. Check your connection. Saved work on this device was not removed.");
      }
      if (!live || !facilities) return;
      const stored = await getOfflineSetting(selectedFacilityKey(owner)).catch(() => null);
      const storedId = typeof stored?.value === "string" ? stored.value : null;
      const remembered = storedId && facilities.some((facility) => facility.id === storedId) ? storedId : null;
      setList(facilities);
      setOffline(usedCache);
      setPreferred(remembered);
      setChanging(!remembered);
      setDraft(initialDraft(facilities, remembered));
    })();
    return () => { live = false; };
  }, [principal?.userId, principal?.organizationId]);

  const states = list ? statesFrom(list) : [];
  const counties = list ? countiesFrom(list, draft.stateKey) : [];
  const facilities = list ? facilitiesFrom(list, draft.stateKey, draft.countyKey) : [];
  const chosen = list?.find((facility) => facility.id === draft.facilityId) ?? null;
  const canContinue = !!principal && !!chosen;

  function update(changed: "state" | "county" | "facility", value: string) {
    if (!list) return;
    const next = { ...draft };
    if (changed === "state") next.stateKey = keyFromOption(value);
    if (changed === "county") next.countyKey = keyFromOption(value);
    if (changed === "facility") next.facilityId = value;
    setDraft(narrowDraft(list, next, changed));
  }

  async function acceptLocation(destination: "/scan" | "/setup-opening") {
    if (!principal || !chosen) {
      setFacilityHint("Choose a facility and tap Continue first.");
      return;
    }
    setFacilityHint("");
    await putOfflineSetting({ key: selectedFacilityKey(principal), value: chosen.id, updatedAt: new Date().toISOString() });
    writeLocationConfirmation(sessionStorage, principal, chosen.id);
    sync?.select(chosen.id);
    navigate(destination, { replace: true });
  }

  return <div className="app-shell c04"><div className="screen">
    <p className="c04-kicker">Field app</p>
    <h1>Choose a location</h1>
    <p className="c04-note">Confirm the state, county, and facility before scanning. This uses the facilities already authorized for this account.</p>
    {list === null && !error && <p className="c04-band" role="status">Loading your facilities.</p>}
    {error && <p className="c04-alert" role="alert">{error}</p>}
    {offline && <p className="c04-band-blue">Showing facilities already saved for this account on this device.</p>}
    {list && list.length === 0 && <section className="c04-alert" role="status">
      <p>No facilities are assigned to this account. A location cannot be chosen until an administrator assigns one. Scan does not open in its place.</p>
    </section>}
    {list && list.length > 0 && <>
      {preferred && !changing && <section className="c04-band-green" aria-label="Last location">
        <p className="c04-eyebrow">Last location</p>
        <p><strong>{describeLocation(list, preferred)}</strong></p>
        <p>Continue confirms this location. Change it if you are working somewhere else.</p>
        <button type="button" className="btn c04-btn-blue" onClick={() => void acceptLocation("/scan")}>Continue</button>
        <button type="button" className="btn c04-btn-cyan" onClick={() => setChanging(true)}>Change location</button>
      </section>}
      {(!preferred || changing) && <section className="c04-band" aria-label="State, county, and facility">
        <div className="field"><label htmlFor="location-state">State</label>
          <select id="location-state" value={draft.stateKey === null ? "" : optionValue(draft.stateKey)} onChange={(event) => update("state", event.target.value)}>
            <option value="">Choose a state</option>
            {states.map((state) => <option key={optionValue(state.key)} value={optionValue(state.key)}>{state.label}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="location-county">County</label>
          <select id="location-county" value={draft.countyKey === null ? "" : optionValue(draft.countyKey)} onChange={(event) => update("county", event.target.value)} disabled={draft.stateKey === null}>
            <option value="">Choose a county</option>
            {counties.map((county) => <option key={optionValue(county.key)} value={optionValue(county.key)}>{county.label}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="location-facility">Facility</label>
          <select id="location-facility" value={draft.facilityId} onChange={(event) => update("facility", event.target.value)} disabled={draft.countyKey === null}>
            <option value="">Choose a facility</option>
            {facilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name}</option>)}
          </select>
        </div>
        {chosen && <p role="status">Selected location: {describeLocation(list, chosen.id)}</p>}
        <button type="button" className="btn c04-btn-blue" disabled={!canContinue} onClick={() => void acceptLocation("/scan")}>Continue</button>
        {preferred && <button type="button" className="btn c04-choice" onClick={() => { setChanging(false); setDraft(initialDraft(list, preferred)); }}>Keep last location</button>}
      </section>}
    </>}
    {(auth?.role === "admin" || auth?.role === "facilities_manager") && <>
      {facilityHint && <p className="c04-note" role="status">{facilityHint}</p>}
      <button type="button" className="btn c04-choice" onClick={() => void acceptLocation("/setup-opening")}>Facilities and openings</button>
    </>}
    <button type="button" className="btn c04-choice" disabled={logoutPending} onClick={() => void logout()}>{logoutPending ? "Signing out…" : "Sign out"}</button>
  </div></div>;
}
