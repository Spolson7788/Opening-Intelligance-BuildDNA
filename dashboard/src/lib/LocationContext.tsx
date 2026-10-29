import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getLocations, setTreeScope } from "./api";
import type { LocationsResponse } from "./api";
import { DEFAULT_FILTER, LocationIndex, needsTree, parseFilter } from "./locationScope";
import type { LocationFilter, LocationRow } from "./locationScope";
import { useAuth } from "./AuthContext";

const KEY = "oi_location_filter";
interface Ctx {
  index: LocationIndex; filter: LocationFilter; setFilter: (f: LocationFilter) => void;
  /** Changes whenever the data scope changes; pages are re-mounted on it so every list re-reads. */
  scopeKey: string;
  label: (r: object) => string; inFilter: (r: object) => boolean; combined: boolean;
  writeState: (r: object) => "write" | "switch_to_edit" | "view_only";
  sortRows: <T extends object>(rows: T[], on: boolean) => T[];
}
const LocationCtx = createContext<Ctx | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const { auth } = useAuth();
  const [data, setData] = useState<LocationsResponse | null>(null);
  const [filter, setFilterState] = useState<LocationFilter>(() => parseFilter(typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null));
  useEffect(() => {
    if (!auth) { setData(null); return; }
    getLocations().then(setData).catch(() => setData(null));
  }, [auth?.userId, auth?.organizationId]);
  const index = useMemo(() => new LocationIndex(data), [data]);
  // Without a visible tree there is nothing to combine: fall back to the company view.
  const effective: LocationFilter = index.tree ? filter : DEFAULT_FILTER;
  setTreeScope(needsTree(effective));
  const setFilter = (f: LocationFilter) => { localStorage.setItem(KEY, JSON.stringify(f)); setFilterState(f); };
  const value: Ctx = {
    index, filter: effective, setFilter, scopeKey: `${auth?.organizationId ?? ""}:${JSON.stringify(effective)}:${data ? 1 : 0}`,
    label: r => index.label(r as LocationRow), inFilter: r => index.inFilter(r as LocationRow, effective), combined: needsTree(effective),
    writeState: r => index.writeState(r as LocationRow),
    sortRows: (rows, on) => on ? [...rows].sort((a, b) => index.label(a as LocationRow).localeCompare(index.label(b as LocationRow))) : rows,
  };
  return <LocationCtx.Provider value={value}>{children}</LocationCtx.Provider>;
}
export function useLocations() {
  const c = useContext(LocationCtx);
  if (!c) throw new Error("useLocations must be used within LocationProvider");
  return c;
}
