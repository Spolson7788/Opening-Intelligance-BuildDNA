import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchMe, fetchOpening, listFieldProperties, listOpenings, searchFieldFacilities } from "../lib/api";
import { isAppSessionFailure } from "../lib/siteAccess";
import { ALL_AREAS, areaFilterKey, defaultAreaFilter, filterFacilitiesByArea, type AreaFilter, type AreaPreferences } from "../lib/facilityArea";
import { getOfflineSetting, putOfflineSetting } from "../lib/db";
import { useAuth } from "../lib/AuthContext";
import type { FacilityProperty } from "../lib/facilityOpenings";
import { chooseFacility, describeSync, facilitySyncKey, retryFailedOpenings, selectedFacilityKey, shouldRefresh, syncFacility, type FacilitySyncProgress, type FacilitySyncResult } from "../lib/facilitySync";

interface FacilitySyncValue {
  properties: FacilityProperty[] | null; selectedId: string | null; progress: FacilitySyncProgress | null; result: FacilitySyncResult | null;
  running: boolean; error: string | null; select(id: string): void; refresh(): void; retryFailed(): void;
  area: AreaFilter; home: AreaFilter; setArea(a: AreaFilter): void;
}
const Ctx = createContext<FacilitySyncValue | null>(null);
export const useFacilitySync = () => useContext(Ctx);

// After sign-in: load the facilities this user can reach, restore the selection (or pick the
// only one), then download every opening of the selected facility. Reselecting, resuming the
// app or coming back online refreshes it.
export function FacilitySyncProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { auth } = useAuth();
  const principal = auth ? { userId: auth.userId, organizationId: auth.organizationId } : null;
  const pkey = principal ? `${principal.userId}/${principal.organizationId}` : "";
  const [properties, setProperties] = useState<FacilityProperty[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<FacilitySyncProgress | null>(null);
  const [result, setResult] = useState<FacilitySyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // t97 item 1: area filter narrows the authorized list only; default is the home area (branch default or home state).
  const [area, setAreaState] = useState<AreaFilter>(ALL_AREAS);
  const [home, setHome] = useState<AreaFilter>(ALL_AREAS);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<FacilitySyncResult | null>(null); resultRef.current = result;
  const deps = { listOpenings: (b: string) => listOpenings({ building_id: b }), fetchOpening: (id: string) => fetchOpening(id),
    putSetting: (key: string, value: unknown) => putOfflineSetting({ key, value, updatedAt: new Date().toISOString() }) as Promise<void> };

  const run = useCallback((id: string) => {
    if (!principal || !properties) return;
    const property = properties.find((p) => p.id === id); if (!property) return;
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setRunning(true); setError(null);
    syncFacility(deps, principal, property, { signal: ac.signal, onProgress: (p) => { if (!ac.signal.aborted) setProgress(p); } })
      .then((r) => { if (!ac.signal.aborted) { setResult(r); setProgress(null); } })
      .catch((error) => { if (!ac.signal.aborted && !isAppSessionFailure(error)) setError("Download failed. Retry when you have a connection."); })
      .finally(() => { if (abortRef.current === ac) setRunning(false); });
  }, [pkey, properties]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setProperties(null); setSelectedId(null); setResult(null); setProgress(null); setError(null);
    abortRef.current?.abort();
    if (!enabled || !principal) return;
    let stop = false;
    (async () => {
      const stored = await getOfflineSetting(selectedFacilityKey(principal)).catch(() => null);
      let list: FacilityProperty[] | null = null;
      try { list = await listFieldProperties(); await putOfflineSetting({ key: `facilities:${principal.userId}:${principal.organizationId}`, value: list, updatedAt: new Date().toISOString() }); }
      catch (error) { const c = await getOfflineSetting(`facilities:${principal.userId}:${principal.organizationId}`).catch(() => null); list = (c?.value as FacilityProperty[]) ?? null; if (!list && !isAppSessionFailure(error)) setError("Couldn't load your facilities. Check your connection."); }
      if (stop || !list) return;
      setProperties(list);
      let prefs: AreaPreferences | null = null;
      const prefKey = `area-preferences:${principal.userId}:${principal.organizationId}`;
      try { prefs = ((await searchFieldFacilities()) as any)?.preferences ?? null; await putOfflineSetting({ key: prefKey, value: prefs, updatedAt: new Date().toISOString() }); }
      catch { prefs = ((await getOfflineSetting(prefKey).catch(() => null))?.value as AreaPreferences) ?? null; }
      const storedArea = (await getOfflineSetting(areaFilterKey(principal)).catch(() => null))?.value as AreaFilter | undefined;
      if (stop) return;
      const homeArea = defaultAreaFilter(prefs, list); setHome(homeArea);
      setAreaState(storedArea && (storedArea.kind === "all" || filterFacilitiesByArea(list, storedArea).length) ? storedArea : homeArea);
      // M5: with no saved choice on this device, fall back to the default facility the admin set.
      let preferred: string | null = (stored?.value as string) ?? null;
      if (!preferred) preferred = await fetchMe().then((m) => m.default_property_id).catch(() => null);
      if (stop) return;
      const id = chooseFacility(list, preferred);
      if (id) { setSelectedId(id); const last = await getOfflineSetting(facilitySyncKey(principal, id)).catch(() => null); if (!stop && last?.value) setResult(last.value as FacilitySyncResult); }
    })();
    return () => { stop = true; abortRef.current?.abort(); };
  }, [enabled, pkey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Download on selection (including the restored or auto-selected one after sign-in).
  useEffect(() => { if (selectedId && properties && navigator.onLine !== false) run(selectedId); }, [selectedId, properties, run]);

  // Refresh on app resume or reconnect.
  useEffect(() => {
    if (!enabled) return;
    const onResume = () => {
      if (document.visibilityState !== "visible" || !selectedId || running) return;
      if (shouldRefresh(resultRef.current?.finishedAt, Date.now())) run(selectedId); };
    document.addEventListener("visibilitychange", onResume); window.addEventListener("online", onResume);
    return () => { document.removeEventListener("visibilitychange", onResume); window.removeEventListener("online", onResume); };
  }, [enabled, selectedId, running, run]);

  const select = (id: string) => {
    if (!principal) return;
    void putOfflineSetting({ key: selectedFacilityKey(principal), value: id, updatedAt: new Date().toISOString() });
    setResult(null);
    if (id === selectedId) run(id); else setSelectedId(id);
  };
  const setArea = (a: AreaFilter) => {
    setAreaState(a);
    if (principal) void putOfflineSetting({ key: areaFilterKey(principal), value: a, updatedAt: new Date().toISOString() });
  };
  const retryFailed = () => {
    if (!principal || !result) return;
    if (result.status === "failed" || result.buildingsFailed.length) { run(result.propertyId); return; }
    setRunning(true);
    retryFailedOpenings(deps, principal, result, { onProgress: (d, t) => setProgress({ phase: "downloading", buildingsDone: 0, buildingsTotal: 0, openingsDone: d, openingsTotal: t, failed: 0, attempt: 2 }) })
      .then((r) => { setResult(r); setProgress(null); }).finally(() => setRunning(false));
  };
  return <Ctx.Provider value={{ properties, selectedId, progress, result, running, error, select, refresh: () => selectedId && run(selectedId), retryFailed, area, home, setArea }}>{children}</Ctx.Provider>;
}

/** Facility selection step and download status (shown on the home screen after sign-in). */
export function FacilitySelector() {
  const s = useFacilitySync();
  if (!s) return null;
  const { properties, selectedId, progress, result, running, error } = s;
  const needsChoice = properties && properties.length > 1 && !selectedId;
  const groups = [...(properties ?? []).reduce((map, facility) => {
    const key = `${facility.state_name ?? "State not set"} / ${facility.county_name ?? "County not set"}`;
    map.set(key, [...(map.get(key) ?? []), facility]);
    return map;
  }, new Map<string, NonNullable<typeof properties>>())].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <section className="card" aria-label="Facilities by state and county" style={{ marginBottom: 12 }}>
      {properties === null && !error && <p>Loading your facilities...</p>}
      {properties && properties.length === 0 && <p>No facilities are assigned to your account yet.</p>}
      {needsChoice && <p><strong>Select your facility to download its openings</strong></p>}
      {groups.map(([label, facilities]) => (
        <div key={label}>
          <div className="section-label">{label}</div>
          {facilities.map((facility) => (
            <button key={facility.id} type="button" className="btn btn-secondary" style={{ textAlign: "left", marginBottom: 8 }}
              onClick={() => s.select(facility.id)} aria-current={facility.id === selectedId ? "true" : undefined}>
              {facility.name}{facility.city ? `, ${facility.city}` : ""}
            </button>
          ))}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      {(progress || result) && <p role="status">{describeSync(progress, result)}</p>}
      {progress && progress.openingsTotal > 0 && <progress max={progress.openingsTotal} value={progress.openingsDone} style={{ width: "100%" }} />}
      {selectedId && !running && <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-secondary" onClick={() => s.refresh()}>Refresh download</button>
        {result && result.status !== "complete" && result.status !== "cancelled" && <button type="button" className="btn btn-secondary" onClick={() => s.retryFailed()}>Retry failed</button>}
      </div>}
    </section>
  );
}