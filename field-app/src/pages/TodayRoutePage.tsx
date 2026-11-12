import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchFieldRoute, fetchNearbyWork, markFieldStopDone, requestNearbyWork, type FieldRoute, type NearbyWork } from "../lib/fieldRoutes";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function workLabel(kind: string) {
  if (kind === "inspection") return "Inspection";
  if (kind === "advised_repair") return "Advised repair";
  return "Work order";
}

export function TodayRoutePage() {
  const [route, setRoute] = useState<FieldRoute | null>(null);
  const [apple, setApple] = useState(false);
  const [nearby, setNearby] = useState<NearbyWork[]>([]);
  const [radius, setRadius] = useState(15);
  const [showNearby, setShowNearby] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const [day, extra] = await Promise.all([fetchFieldRoute(today()), fetchNearbyWork().catch(() => ({ nearby: [], radius_miles: 15 }))]);
    setRoute(day.route);
    setApple(day.apple_maps);
    setNearby(extra.nearby);
    setRadius(extra.radius_miles);
  }

  useEffect(() => {
    document.body.classList.add("c04-on");
    load().catch((err) => setError(err instanceof Error ? err.message : "Could not load today's route."));
    return () => document.body.classList.remove("c04-on");
  }, []);

  async function done(id: string) {
    setError(null);
    try {
      await markFieldStopDone(id);
      setNote("Marked done.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark this stop done.");
    }
  }

  async function add(work: NearbyWork) {
    setError(null);
    try {
      await requestNearbyWork({ work_kind: work.work_kind, work_id: work.work_id });
      setNote("Requested. A manager still has to approve it.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request this work.");
    }
  }

  const stops = route?.stops ?? [];
  const next = stops.find((stop) => !stop.done);

  return (
    <div className="app-shell c04">
      <div className="screen">
        <Link className="btn c04-btn-green" to="/scan">Back</Link>
        <h1>Today's route</h1>
        {error && <p className="c04-alert" role="alert">{error}</p>}
        {note && <p role="status">{note}</p>}
        {!route && <p>No route is assigned to you for today.</p>}
        {route && (
          <section className="c04-band" aria-label="Route summary">
            <p>{stops.length} stops · {route.total_minutes} min drive</p>
            {next && <p>Next: {next.property_name}</p>}
          </section>
        )}
        {stops.map((stop, index) => (
          <article className="c04-band" key={stop.id}>
            <h2>{index + 1}. {stop.property_name}</h2>
            <p>{stop.address}</p>
            <p>{stop.time_window || "No time window"}</p>
            <p>{workLabel(stop.work_kind)} · {stop.summary}{stop.opening_code ? ` · ${stop.opening_code}` : ""}</p>
            <p>{stop.drive_minutes === null ? (index === 0 ? "Start of the route" : "No map location, so this stop is not in the drive time.") : `${stop.drive_minutes} min from the previous stop`}</p>
            <a className="btn c04-btn-blue" href={apple ? stop.maps.apple : stop.maps.google} target="_blank" rel="noreferrer">Open in Maps</a>
            {stop.done
              ? <p>Done</p>
              : <button type="button" className="btn c04-btn-green" onClick={() => { void done(stop.id); }}>Mark done</button>}
          </article>
        ))}
        <button type="button" className="btn c04-btn-cyan" onClick={() => setShowNearby((open) => !open)}>Nearby work</button>
        {showNearby && (
          <section aria-label="Nearby work">
            <h2>Within {radius} miles</h2>
            {nearby.length === 0 && <p>No approved nearby work from here.</p>}
            {nearby.map((work) => (
              <article className="c04-band" key={`${work.work_kind}-${work.work_id}`}>
                <h2>{work.property_name}</h2>
                <p>{work.address}</p>
                <p>{workLabel(work.work_kind)} · {work.summary} · {work.miles} miles</p>
                {work.schedule_only
                  ? <p>Schedule only. This facility needs notice, so it cannot be picked up.</p>
                  : <button type="button" className="btn c04-btn-green" onClick={() => { void add(work); }}>Add to route</button>}
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
