import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { useFacilitySync } from "../components/FacilitySelector";
import { fetchFieldRoute, type FieldRoute, type FieldStop } from "../lib/fieldRoutes";
import { googleStopUrl } from "../lib/navigateStops";
import { selectTaskSite } from "../lib/taskSite";

function today() { return new Date().toISOString().slice(0, 10); }

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
  useEffect(() => {
    let live = true;
    fetchFieldRoute(today()).then((day) => {
      if (!live) return;
      setRoute(day.route);
      setApple(day.apple_maps);
    }).catch((err) => {
      if (!live) return;
      setRoute(null);
      setError(err instanceof Error ? err.message : "Could not load today's route.");
    });
    return () => { live = false; };
  }, []);
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
      {route === null && <p>No stops scheduled today. Check with your manager.</p>}
    </TaskChrome>
  );
}
