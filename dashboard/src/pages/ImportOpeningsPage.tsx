import { useEffect, useState } from "react";
import Papa from "papaparse";
import { useNavigate } from "react-router-dom";
import { listProperties, bulkImportOpenings } from "../lib/api";
import type { Property, BulkImportRow, BulkImportResult } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

const VALID_TYPES = ["door", "overhead_door", "loading_dock", "gate", "automatic_entrance", "access_control_point"];
const CHUNK_SIZE = 1000; // matches the API's per-request row cap

function coerceBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).trim().toLowerCase();
  return ["true", "yes", "1"].includes(s);
}

const TEMPLATE_CSV =
  "opening_code,opening_type,floor_label,location_description,fire_rated,life_safety_critical,is_electrified,install_date\n" +
  "AZ-PHX-BLDGA-F01-0001,door,F01,East stairwell door,true,true,true,2015-06-01\n" +
  "AZ-PHX-BLDGA-F01-0002,door,F01,West stairwell door,false,false,false,\n";

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "openings-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface ParsedRow extends BulkImportRow {
  _valid: boolean;
  _issue?: string;
}

export function ImportOpeningsPage() {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  useEffect(() => {
    listProperties()
      .then(setProperties)
      .catch(() => setParseError("Couldn't load your properties. Check your connection and try again."));
  }, []);

  const buildingsForProperty = properties.find((p) => p.id === propertyId)?.buildings ?? [];

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError(null);
    setResult(null);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        if (res.errors.length > 0) {
          setParseError(`CSV parse error: ${res.errors[0].message} (row ${res.errors[0].row})`);
          setParsedRows([]);
          return;
        }
        const rows: ParsedRow[] = (res.data as any[]).map((raw) => {
          const opening_code = (raw.opening_code || "").trim();
          const opening_type = (raw.opening_type || "").trim();
          let issue: string | undefined;
          if (!opening_code) issue = "missing opening_code";
          else if (!VALID_TYPES.includes(opening_type)) issue = `invalid opening_type "${opening_type}"`;

          return {
            opening_code,
            opening_type,
            floor_label: raw.floor_label || undefined,
            location_description: raw.location_description || undefined,
            fire_rated: coerceBoolean(raw.fire_rated),
            life_safety_critical: coerceBoolean(raw.life_safety_critical),
            is_electrified: coerceBoolean(raw.is_electrified),
            install_date: raw.install_date || undefined,
            _valid: !issue,
            _issue: issue,
          };
        });
        setParsedRows(rows);
      },
      error: (err: Error) => setParseError(err.message),
    });
  }

  async function onSubmit() {
    if (!buildingId) return;
    const validRows = parsedRows.filter((r) => r._valid);
    if (validRows.length === 0) return;

    setSubmitting(true);
    setResult(null);
    setSubmitProgress({ done: 0, total: validRows.length });

    const aggregate: BulkImportResult = { total: 0, created: 0, failed: 0, results: [] };
    try {
      for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE).map(({ _valid, _issue, ...row }) => row);
        const chunkResult = await bulkImportOpenings(buildingId, chunk);
        aggregate.total += chunkResult.total;
        aggregate.created += chunkResult.created;
        aggregate.failed += chunkResult.failed;
        aggregate.results.push(...chunkResult.results);
        setSubmitProgress({ done: Math.min(i + CHUNK_SIZE, validRows.length), total: validRows.length });
      }
      setResult(aggregate);
    } catch {
      setParseError("Import failed partway through — check your connection. Rows already created are safe; re-uploading will skip duplicates.");
    } finally {
      setSubmitting(false);
      setSubmitProgress(null);
    }
  }

  const validCount = parsedRows.filter((r) => r._valid).length;
  const invalidCount = parsedRows.length - validCount;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main" style={{ maxWidth: 720 }}>
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        <div className="panel">
          <h2 style={{ marginBottom: 4 }}>Import Openings</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20 }}>
            Bulk-create openings from a CSV instead of one at a time. Good for onboarding a whole building at once.
          </p>

          <div className="filter-bar" style={{ marginBottom: 20 }}>
            <select
              value={propertyId}
              onChange={(e) => { setPropertyId(e.target.value); setBuildingId(""); }}
            >
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} disabled={!propertyId}>
              <option value="">Select building…</option>
              {buildingsForProperty.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          {properties.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              No properties yet — <a href="/properties/new">create one first</a>.
            </p>
          )}

          <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
            <label className="btn" style={{ width: "auto", cursor: "pointer", padding: "0 16px" }}>
              {fileName || "Choose CSV file"}
              <input type="file" accept=".csv" onChange={onFileSelected} style={{ display: "none" }} disabled={!buildingId} />
            </label>
            <button
              onClick={downloadTemplate}
              style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
            >
              Download template
            </button>
          </div>
          {!buildingId && <p style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: -8, marginBottom: 16 }}>Select a property and building first.</p>}

          {parseError && <p className="error-text">{parseError}</p>}

          {parsedRows.length > 0 && !result && (
            <>
              <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 13 }}>
                <span><strong>{parsedRows.length}</strong> rows parsed</span>
                <span style={{ color: "var(--success)" }}><strong>{validCount}</strong> valid</span>
                {invalidCount > 0 && <span style={{ color: "var(--danger)" }}><strong>{invalidCount}</strong> will be skipped</span>}
              </div>

              <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 16 }}>
                <table>
                  <thead>
                    <tr><th>Code</th><th>Type</th><th>Floor</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 200).map((r, i) => (
                      <tr key={i}>
                        <td>{r.opening_code || <em style={{ color: "var(--text-secondary)" }}>—</em>}</td>
                        <td>{r.opening_type}</td>
                        <td>{r.floor_label || "—"}</td>
                        <td>
                          {r._valid
                            ? <span className="health-pill health-good">Ready</span>
                            : <span className="health-pill health-poor" title={r._issue}>{r._issue}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsedRows.length > 200 && (
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: -10, marginBottom: 16 }}>
                  Showing first 200 of {parsedRows.length} rows.
                </p>
              )}

              <button className="btn btn-primary" onClick={onSubmit} disabled={submitting || validCount === 0}>
                {submitting
                  ? submitProgress
                    ? `Importing… ${submitProgress.done}/${submitProgress.total}`
                    : "Importing…"
                  : `Import ${validCount} Opening${validCount === 1 ? "" : "s"}`}
              </button>
            </>
          )}

          {result && (
            <div className="card" style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
                <div>
                  <div className="label" style={{ fontSize: 11, color: "var(--text-secondary)" }}>CREATED</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--success)" }}>{result.created}</div>
                </div>
                <div>
                  <div className="label" style={{ fontSize: 11, color: "var(--text-secondary)" }}>FAILED</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: result.failed > 0 ? "var(--danger)" : "var(--text)" }}>{result.failed}</div>
                </div>
              </div>
              {result.failed > 0 && (
                <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 13, marginBottom: 12 }}>
                  {result.results.filter((r) => r.status === "error").map((r) => (
                    <div key={r.row} style={{ color: "var(--danger)", marginBottom: 4 }}>
                      Row {r.row + 1} ({r.opening_code}): {r.error}
                    </div>
                  ))}
                </div>
              )}
              <button className="btn btn-primary" onClick={() => navigate("/")}>Back to Portfolio</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
