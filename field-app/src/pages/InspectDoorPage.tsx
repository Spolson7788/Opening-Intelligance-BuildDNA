import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { fetchOpeningByCode } from "../lib/api";
import { LogInspectionEventPage } from "./LogInspectionEventPage";

export function InspectDoorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (id) return <LogInspectionEventPage taskMode />;

  async function lookup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const found = await fetchOpeningByCode(code.trim());
      const openingId = found.opening?.id;
      if (!openingId) throw new Error("missing");
      navigate(`/tasks/inspect/${openingId}`);
    } catch {
      setError("That door code was not found. Try the number on the door.");
    }
  }

  return (
    <TaskChrome title="Inspect this door" hint="Scan is on the current screen. Or type the door number." backTo="/tasks/day">
      {error && <p className="c04-alert" role="alert">{error}</p>}
      <form onSubmit={lookup}>
        <div className="field">
          <label htmlFor="door-code">Door number</label>
          <input id="door-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="510A" />
        </div>
        <button className="btn c04-btn-blue" type="submit">Look up door</button>
      </form>
      <Link className="btn c04-choice" to="/scan">Scan on the current screen</Link>
    </TaskChrome>
  );
}
