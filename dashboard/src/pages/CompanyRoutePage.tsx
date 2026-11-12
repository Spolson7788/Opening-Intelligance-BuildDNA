import { useEffect, useState } from "react";
import { BackLink, CompanyShell } from "../components/CompanyShell";
import {
  buildServiceRoute, decideRouteStop, fetchRouteAssignees, fetchRouteCandidates, fetchServiceRoutes,
  type RouteCandidate, type ServiceRoute,
} from "../lib/api";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function workLabel(kind: string) {
  if (kind === "inspection") return "Inspection";
  if (kind === "advised_repair") return "Advised repair";
  return "Work order";
}

export function CompanyRoutePage() {
  const [date, setDate] = useState(today);
  const [people, setPeople] = useState<Array<{ id: string; full_name: string; role: string }>>([]);
  const [assignee, setAssignee] = useState("");
  const [candidates, setCandidates] = useState<RouteCandidate[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [routes, setRoutes] = useState<ServiceRoute[]>([]);
  const [driveLabel, setDriveLabel] = useState("Drive times saved with this route.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(nextDate = date) {
    const [who, work, saved] = await Promise.all([
      fetchRouteAssignees(),
      fetchRouteCandidates(nextDate),
      fetchServiceRoutes(nextDate),
    ]);
    setPeople(who.people);
    setAssignee((current) => current || who.people[0]?.id || "");
    setCandidates(work.candidates);
    setRoutes(saved.routes);
    if (saved.drive_label) setDriveLabel(saved.drive_label);
  }

  useEffect(() => {
    let live = true;
    load(date).catch((err) => { if (live) setError(err instanceof Error ? err.message : "Could not load the route."); });
    return () => { live = false; };
  }, [date]);

  function toggle(candidate: RouteCandidate) {
    setPicked((current) => {
      const next = { ...current };
      if (candidate.work_id in next) delete next[candidate.work_id];
      else next[candidate.work_id] = "";
      return next;
    });
  }

  async function build() {
    setError(null);
    const stops = candidates.filter((candidate) => candidate.work_id in picked).map((candidate) => ({
      work_kind: candidate.work_kind,
      work_id: candidate.work_id,
      time_window: picked[candidate.work_id] || undefined,
    }));
    if (!assignee || stops.length === 0) {
      setError("Choose a person and at least one stop.");
      return;
    }
    setBusy(true);
    try {
      const built = await buildServiceRoute({ service_date: date, assigned_user_id: assignee, stops });
      setDriveLabel(built.drive_label);
      setPicked({});
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the route.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "approve" | "decline") {
    setError(null);
    try {
      await decideRouteStop(id, decision);
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the request.");
    }
  }

  const pending = routes.flatMap((route) => route.stops.filter((stop) => stop.status === "requested").map((stop) => ({ ...stop, assignee_name: route.assignee_name })));
  const active = routes.map((route) => ({ ...route, stops: route.stops.filter((stop) => stop.status === "approved") }));

  return (
    <CompanyShell title="Today's route">
      <BackLink to="/">Back to customers</BackLink>
      <section className="c04-kpis" aria-label="Route summary">
        <article className="c04-tile">
          <div className="lab">Date</div>
          <div className="val" style={{ fontSize: 22 }}>{date}</div>
          <div className="st">One person for this route</div>
        </article>
        <article className="c04-tile">
          <div className="lab">Total drive</div>
          <div className="val">{active.reduce((sum, route) => sum + route.total_minutes, 0)} min</div>
          <div className="st">{driveLabel}</div>
        </article>
        <article className="c04-tile">
          <div className="lab">Pending requests</div>
          <div className={pending.length ? "val amber" : "val"}>{pending.length}</div>
          <div className="st">A manager approves nearby work</div>
        </article>
      </section>
      {error && <p className="c04-error" role="alert">{error}</p>}
      <section className="c04-card">
        <div className="c04-band green"><div><h2>Build the route</h2><p>Stops are ordered by drive time. A time window is optional and does not change the order.</p></div></div>
        <div className="c04-body">
          <label className="c04-field">Date
            <input type="date" value={date} onChange={(event) => { setDate(event.target.value); setDriveLabel("Drive times saved with this route."); }} />
          </label>
          <label className="c04-field">Assign to
            <select aria-label="Assign to" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              {people.map((person) => <option key={person.id} value={person.id}>{person.full_name} ({person.role.replace("_", " ")})</option>)}
            </select>
          </label>
          {candidates.length === 0 && <p className="c04-note">No open work orders or due inspections for this date.</p>}
          {candidates.map((candidate) => (
            <div className="c04-route-row" key={`${candidate.work_kind}-${candidate.work_id}`}>
              <input type="checkbox" aria-label={`Include ${candidate.summary}`} checked={candidate.work_id in picked} onChange={() => toggle(candidate)} />
              <div>
                <strong>{candidate.property_name}</strong>
                <p>{workLabel(candidate.work_kind)} · {candidate.summary}{candidate.opening_code ? ` · ${candidate.opening_code}` : ""}</p>
                <p className="c04-note">{candidate.address}{candidate.latitude === null ? " · No map location" : ""}</p>
                {candidate.work_id in picked && (
                  <label className="c04-field">Time window
                    <input aria-label={`Time window for ${candidate.summary}`} value={picked[candidate.work_id]} placeholder="Optional, for example 9:00–11:00" onChange={(event) => setPicked((current) => ({ ...current, [candidate.work_id]: event.target.value }))} />
                  </label>
                )}
              </div>
            </div>
          ))}
          <button type="button" className="c04-btn green" disabled={busy} onClick={() => { void build(); }}>{busy ? "Saving…" : "Save route"}</button>
        </div>
      </section>
      {active.map((route) => (
        <section className="c04-card" key={route.id}>
          <div className="c04-band blue"><div><h2>{route.assignee_name || "Assigned route"}</h2><p>{route.total_minutes} minutes of drive time. Each leg is the drive to that stop.</p></div></div>
          <div className="c04-body">
            {route.stops.map((stop, index) => (
              <article className="c04-row" key={stop.id}>
                <h3>{index + 1}. {stop.property_name}</h3>
                <p>{workLabel(stop.work_kind)} · {stop.summary}</p>
                <p>{stop.address}</p>
                <p>{stop.time_window || "No time window"} · {stop.drive_minutes === null ? (index === 0 ? "Start of the route" : "No map location, so this stop is not in the drive time.") : `${stop.drive_minutes} min drive from the previous stop`}</p>
              </article>
            ))}
          </div>
        </section>
      ))}
      <section className="c04-card">
        <div className="c04-band cyan"><div><h2>Pending requests</h2><p>Nearby work stays here until you approve or decline it.</p></div></div>
        <div className="c04-body">
          {pending.length === 0 && <p className="c04-note">No pending requests.</p>}
          {pending.map((stop) => (
            <article className="c04-row" key={stop.id}>
              <h3>{stop.property_name}</h3>
              <p>{workLabel(stop.work_kind)} · {stop.summary}</p>
              <p className="c04-note">Requested for {stop.assignee_name || "the assigned person"}</p>
              <div className="c04-actions">
                <button type="button" className="c04-btn green" onClick={() => { void decide(stop.id, "approve"); }}>Approve</button>
                <button type="button" className="c04-btn" onClick={() => { void decide(stop.id, "decline"); }}>Decline</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </CompanyShell>
  );
}
