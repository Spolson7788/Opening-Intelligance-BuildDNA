import { useState } from "react";
import Papa from "papaparse";
import { useNavigate } from "react-router-dom";
import { bulkImportHardware } from "../lib/api";
import type { BulkImportHardwareRow, BulkImportHardwareResult } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

const VALID_COMPONENT_TYPES = [
  "lockset", "cylinder", "closer", "exit_device", "hinge",
  "automatic_operator", "panic_bar", "access_control_reader",
  "keypad", "electric_strike", "power_transfer", "maglock",
  "request_to_exit_device", "other",
];
const CHUNK_SIZE = 1000;

const TEMPLATE_CSV =
  "opening_code,component_type,manufacturer,model_number,serial_number,unit_cost,supplier_name,supplier_contact,carrier,tracking_number,shipment_status,install_date,warranty_expiration,notes\n" +
  "AZ-PHX-BLDGA-F01-0001,lockset,Schlage,ND80BD,SC-88213-A,340.50,Southwest Security Supply,(602) 555-0134,ups,1Z999AA10123456784,delivered,2015-06-01,2020-06-01,\n" +
  "AZ-PHX-BLDGA-F01-0001,closer,LCN,4040XP,,150.00,Southwest Security Supply,(602) 555-0134,,,,2015-06-01,,\n" +
  "AZ-PHX-BLDGA-F01-0001,hinge,Hager,BB1279,,18.00,,,,,,,,\n" +
  "AZ-PHX-BLDGA-F01-0001,hinge,Hager,BB1279,,18.00,,,,,,,,\n" +
  "AZ-PHX-BLDGA-F01-0001,hinge,Hager,BB1279,,18.00,,,,,,,,\n" +
  "AZ-PHX-BLDGA-F01-0001,keypad,HID,R40-CL,,425.99,Southwest Security Supply,(602) 555-0134,fedex,784509876123,in_transit,,,\n" +
  "AZ-PHX-BLDGA-F01-0001,electric_strike,HES,9600,,210.00,,,,,,,,\n";

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "hardware-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface ParsedRow extends BulkImportHardwareRow {
  _valid: boolean;
  _issue?: string;
}

export function ImportHardwarePage() {
  const navigate = useNavigate();
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkImportHardwareResult | null>(null);

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
          const component_type = (raw.component_type || "").trim();
          let issue: string | undefined;
          if (!opening_code) issue = "missing opening_code";
          else if (!VALID_COMPONENT_TYPES.includes(component_type)) issue = `invalid component_type "${component_type}"`;

          return {
            opening_code,
            component_type,
            manufacturer: raw.manufacturer || undefined,
            model_number: raw.model_number || undefined,
            serial_number: raw.serial_number || undefined,
            unit_cost: raw.unit_cost ? Number(raw.unit_cost) : undefined,
            supplier_name: raw.supplier_name || undefined,
            supplier_contact: raw.supplier_contact || undefined,
            carrier: raw.carrier || undefined,
            tracking_number: raw.tracking_number || undefined,
            shipment_status: raw.shipment_status || undefined,
            install_date: raw.install_date || undefined,
            warranty_expiration: raw.warranty_expiration || undefined,
            notes: raw.notes || undefined,
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
    const validRows = parsedRows.filter((r) => r._valid);
    if (validRows.length === 0) return;

    setSubmitting(true);
    setResult(null);
    setSubmitProgress({ done: 0, total: validRows.length });

    const aggregate: BulkImportHardwareResult = { total: 0, created: 0, failed: 0, results: [] };
    try {
      for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE).map(({ _valid, _issue, ...row }) => row);
        const chunkResult = await bulkImportHardware(chunk);
        aggregate.total += chunkResult.total;
        aggregate.created += chunkResult.created;
        aggregate.failed += chunkResult.failed;
        aggregate.results.push(...chunkResult.results);
        setSubmitProgress({ done: Math.min(i + CHUNK_SIZE, validRows.length), total: validRows.length });
      }
      setResult(aggregate);
    } catch {
      setParseError("Import failed partway through — check your connection. Parts already created are safe; re-uploading will just add duplicates rather than skip them, so double-check before retrying the whole file.");
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
      <div className="main" style={{ maxWidth: 780 }}>
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        <div className="panel">
          <h2 style={{ marginBottom: 4 }}>Import Hardware</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20 }}>
            Attach hardware parts to openings that already exist, by their opening code — a door commonly needs
            several rows (lockset, hinges, closer, keypad...), all referencing the same code. No property or
            building selection needed; one file can cover openings anywhere in your portfolio. Each part gets a
            unique tracker ID automatically — no need to include one in the file.
          </p>

          <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
            <label className="btn" style={{ width: "auto", cursor: "pointer", padding: "0 16px" }}>
              {fileName || "Choose CSV file"}
              <input type="file" accept=".csv" onChange={onFileSelected} style={{ display: "none" }} />
            </label>
            <button
              onClick={downloadTemplate}
              style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
            >
              Download template
            </button>
          </div>

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
                    <tr><th>Opening Code</th><th>Component</th><th>Manufacturer</th><th>Cost</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 200).map((r, i) => (
                      <tr key={i}>
                        <td>{r.opening_code || <em style={{ color: "var(--text-secondary)" }}>—</em>}</td>
                        <td style={{ textTransform: "capitalize" }}>{r.component_type?.replace(/_/g, " ")}</td>
                        <td>{r.manufacturer || "—"}</td>
                        <td>{r.unit_cost ? `$${r.unit_cost.toFixed(2)}` : "—"}</td>
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
                  : `Import ${validCount} Part${validCount === 1 ? "" : "s"}`}
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
                      Row {r.row + 1} ({r.opening_code}, {r.component_type}): {r.error}
                      {r.error === "opening_code not found" && " — check the opening exists and the code is typed exactly right"}
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
