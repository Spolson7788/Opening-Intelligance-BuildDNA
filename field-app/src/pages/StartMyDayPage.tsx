import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { useFacilitySync } from "../components/FacilitySelector";
import { fetchFieldRoute, type FieldRoute, type FieldStop } from "../lib/fieldRoutes";
import { googleStopUrl } from "../lib/navigateStops";
import { selectTaskSite } from "../lib/taskSite";

function today() { return new Date().toISOString().slice(0, 10); }

function doorLine(stop: FieldStop) {
  if (!stop.opening_code) return stop.summary || "No door on this stop";
  return stop.done ? "1 door · 1 done · 0 left" : "1 door · 0 done · 1 left";
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
  const stops = route?.stops ?? [];
  const next = stops.find((stop) => !stop.done);

  async function pick(stop: FieldStop) {
    if (!stop.property_id || opening) {
      setError("This stop has no site to open.");
      return;
    }
    setOpening(true);
    setError(null);
    try {
      await selectTaskSite(stop.property_id);
      sync?.select(stop.property_id);
      navigate("/tasks/site");
    } catch (err) {
      setError(err instanceof Error ? err.message : "This site could not be opened.");
      setOpening(false);
    }
  }

  return (
    <TaskChrome title="Start my day" hint="Today's doors, in the order your manager set.">
      {error && <p className="c04-alert" role="alert">{error}</p>}
      {route === undefined && <p role="status">Loading today's route.</p>}
      {route && stops.map((stop, index) => {
        const maps = apple ? stop.maps?.apple : stop.maps?.google;
        const fallback = googleStopUrl({ address: stop.navigation_address, latitude: stop.latitude, longitude: stop.longitude });
        const href = maps || fallback;
        const isNext = next?.id === stop.id;
        return (
          <section key={stop.id} aria-label={`Stop ${index + 1}`}>
            <button type="button" className="c04-facility" disabled={opening} onClick={() => void pick(stop)}>
              <strong>{index + 1}. {stop.property_name}</strong>
              <span>{stop.time_window || "No time window"}{stop.opening_code ? ` · ${stop.opening_code}` : ""}</span>
              <span>{doorLine(stop)}</span>
            </button>
            {isNext && href && <a className="btn c04-btn-blue" href={href}>Open in Maps</a>}
          </section>
        );
      })}
      {route === null && <>
        <p className="c04-note">No route today. Pick a site instead.</p>
        <Link className="btn c04-btn-blue" to="/choose-location">Pick a site</Link>
      </>}
    </TaskChrome>
  );
}
