import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { useFacilitySync } from "../components/FacilitySelector";
import { fetchFieldRoute, fetchFinishedStops, type FieldRoute, type FieldStop, type FinishedSiteRow } from "../lib/fieldRoutes";
import { googleStopUrl } from "../lib/navigateStops";
import { selectTaskSite } from "../lib/taskSite";
import { localCalendarDay, previousCalendarDay } from "../lib/calendarDay";
import { formatVisitDoorTime } from "../lib/inspectionVisit";

const FIELD_DAY_ZONE = "America/Phoenix";

function today() { return localCalendarDay(new Date(), FIELD_DAY_ZONE); }
function yesterday() { return previousCalendarDay(today()); }

function doorsDoneText(count: number) {
  return `${count} ${count === 1 ? "door" : "doors"} done`;
}

type SiteStop = {
  propertyId: string;
  propertyName: string;
  windows: string[];
  doors: { code: string; done: boolean }[];
  done: number;
  left: number;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  maps: { apple?: string; google?: string } | null;
};

/** One manager stop is one site. Doors at that site stay on the same stop. */
export function groupStopsBySite(stops: FieldStop[]): SiteStop[] {
  const sites: SiteStop[] = [];
  for (const stop of stops) {
    const propertyId = stop.property_id || stop.property_name;
    let site = sites.find((item) => item.propertyId === propertyId);
    if (!site) {
      site = {
        propertyId: stop.property_id, propertyName: stop.property_name, windows: [], doors: [], done: 0, left: 0,
        address: stop.navigation_address, latitude: stop.latitude, longitude: stop.longitude, maps: stop.maps,
      };
      sites.push(site);
    }
    if (stop.time_window && !site.windows.includes(stop.time_window)) site.windows.push(stop.time_window);
    if (stop.opening_code) {
      site.doors.push({ code: stop.opening_code, done: stop.done });
      if (stop.done) site.done += 1;
      else site.left += 1;
    }
  }
  return sites;
}

function doorCount(site: SiteStop) {
  const doors = site.doors.length === 1 ? "1 door" : `${site.doors.length} doors`;
  return `${doors} · ${site.done} done · ${site.left} left`;
}

export function StartMyDayPage() {
  const navigate = useNavigate();
  const sync = useFacilitySync();
  const [route, setRoute] = useState<FieldRoute | null | undefined>(undefined);
  const [apple, setApple] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [yesterdaySites, setYesterdaySites] = useState<FinishedSiteRow[]>([]);
  const [yesterdayNote, setYesterdayNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchFieldRoute(today()).then((day) => {
      if (!live) return;
      setRoute(day.route);
      setApple(day.apple_maps);
    }).catch((err) => {
      if (!live) return;
      setRoute(null);
      const code = err instanceof Error ? err.message : "";
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const plain = timedOut ? "Today's route did not answer. Check your connection."
        : code === "route_unavailable" ? "Today's route is not available right now."
        : code === "missing_token" || code === "unauthorized" ? "Sign in again to see today's route."
        : code || "Could not load today's route.";
      setError(plain);
    });
    return () => { live = false; };
  }, []);
  const emptyToday = !error && (route === null || (route !== undefined && groupStopsBySite(route.stops ?? []).length === 0));
  useEffect(() => {
    if (!emptyToday) { setYesterdaySites([]); setYesterdayNote(null); return; }
    let live = true;
    fetchFinishedStops(yesterday()).then((row) => {
      if (live) setYesterdaySites(Array.isArray(row.sites) ? row.sites : []);
    }).catch(() => { if (live) setYesterdayNote("Yesterday's stops could not be loaded."); });
    return () => { live = false; };
  }, [emptyToday]);
  const sites = groupStopsBySite(route?.stops ?? []);
  const next = sites.find((site) => site.left > 0);
  const scheduled = route != null && sites.length > 0;

  async function pick(site: SiteStop) {
    if (!site.propertyId || opening) return;
    setOpening(true);
    setError(null);
    try {
      await selectTaskSite(site.propertyId);
      sync?.select(site.propertyId);
      navigate("/tasks/site");
    } catch (err) {
      setError(err instanceof Error ? err.message : "This site could not be opened.");
      setOpening(false);
    }
  }

  return (
    <TaskChrome title="Start my day" hint={scheduled ? "Today's doors, in the order your manager set." : ""}>
      {error && <p className="c04-alert" role="alert">{error}</p>}
      {route === undefined && <p role="status">Loading today's route.</p>}
      {scheduled && sites.map((site, index) => {
        const maps = apple ? site.maps?.apple : site.maps?.google;
        const fallback = googleStopUrl({ address: site.address, latitude: site.latitude, longitude: site.longitude });
        const href = maps || fallback;
        return (
          <section key={site.propertyId || site.propertyName} aria-label={`Stop ${index + 1}`}>
            <button type="button" className="c04-facility" disabled={opening} onClick={() => void pick(site)}>
              <strong>{index + 1}. {site.propertyName}</strong>
              <span>{site.windows.join(" · ") || "No time window"}{site.doors.length ? ` · ${site.doors.map((door) => door.code).join(", ")}` : ""}</span>
              <span>{doorCount(site)}</span>
            </button>
            {next?.propertyId === site.propertyId && href && <a className="btn c04-btn-blue" href={href}>Open in Maps</a>}
          </section>
        );
      })}
      {emptyToday && <p>No stops scheduled today. Check with your manager.</p>}
      {emptyToday && yesterdayNote && <p className="c04-note" role="status">{yesterdayNote}</p>}
      {emptyToday && yesterdaySites.length > 0 && (
        <section aria-label="Yesterday">
          <p className="c04-eyebrow">Yesterday</p>
          {yesterdaySites.map((site) => (
            <button type="button" className="c04-facility" key={site.visit_id} onClick={() => navigate(`/tasks/yesterday/${site.visit_id}`, { state: site })}>
              <strong>{site.property_name}</strong>
              <span>{site.address}</span>
              <span>{doorsDoneText(site.doors_done)} · Finished {formatVisitDoorTime(site.finished_at)}</span>
            </button>
          ))}
        </section>
      )}
    </TaskChrome>
  );
}
