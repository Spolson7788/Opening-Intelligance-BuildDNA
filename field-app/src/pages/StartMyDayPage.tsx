import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { fetchFieldRoute, type FieldRoute } from "../lib/fieldRoutes";
import { googleStopUrl } from "../lib/navigateStops";

function today() { return new Date().toISOString().slice(0, 10); }

export function StartMyDayPage() {
  const [route, setRoute] = useState<FieldRoute | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchFieldRoute(today()).then((day) => { if (live) setRoute(day.route); }).catch((err) => {
      if (!live) return;
      setRoute(null);
      setError(err instanceof Error ? err.message : "Could not load today's route.");
    });
    return () => { live = false; };
  }, []);
  const stops = route?.stops ?? [];
  const done = stops.filter((stop) => stop.done).length;
  const left = stops.length - done;
  const next = stops.find((stop) => !stop.done) ?? stops[0];
  const maps = next ? googleStopUrl({ address: next.navigation_address, latitude: next.latitude, longitude: next.longitude }) : null;
  return (
    <TaskChrome title="Start my day" hint="Today's doors, in the order your manager set.">
      {error && <p className="c04-alert" role="alert">{error}</p>}
      {route === undefined && <p role="status">Loading today's route.</p>}
      {route && next && (
        <section className="c04-band-green" aria-label="Next stop">
          <p className="c04-eyebrow">Next stop{next.time_window ? ` · ${next.time_window}` : ""}</p>
          <h2>{next.property_name}</h2>
          <p>{stops.length} doors · {done} done · {left} left</p>
        </section>
      )}
      {route && next && maps && <a className="btn c04-btn-blue" href={maps}>Open next stop in Maps</a>}
      {route && next?.opening_code && <Link className="btn c04-choice" to="/tasks/inspect">Inspect the next door</Link>}
      {route && <Link className="btn c04-choice" to="/today-route">Nearby work</Link>}
      {route === null && <>
        <p className="c04-note">No route today. Pick a site instead.</p>
        <Link className="btn c04-btn-blue" to="/choose-location">Pick a site</Link>
      </>}
      <Link className="btn c04-choice" to="/tasks/finish">Finish the visit</Link>
    </TaskChrome>
  );
}
