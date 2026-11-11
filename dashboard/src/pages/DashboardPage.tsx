import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CompanyShell, formatDay } from "../components/CompanyShell";
import { useAuth } from "../lib/AuthContext";
import { useLocations } from "../lib/LocationContext";
import { fetchCompanyHome, listProperties, type CompanyCustomer } from "../lib/api";
import { facilitiesErrorMessage } from "../lib/scheduleUi";

type KindFilter = "all" | "facility" | "small" | "walkin";

export function DashboardPage() {
  const { auth } = useAuth();
  const loc = useLocations();
  const [customers, setCustomers] = useState<CompanyCustomer[]>([]);
  const [counts, setCounts] = useState({ open_work_orders: 0, failed_or_overdue: 0, inspections_due_30_days: 0, quotes: 0 });
  const [companyName, setCompanyName] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<KindFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchCompanyHome()
      .then((home) => {
        if (!live) return;
        setCustomers(home.customers);
        setCounts(home.counts);
        setCompanyName(home.company_name);
        setNote(home.classification_note);
        setError(null);
      })
      .catch((err) => { if (live) setError(facilitiesErrorMessage(err)); })
      .finally(() => { if (live) setLoading(false); });
    listProperties()
      .then(() => { if (live) setPropertiesError(null); })
      .catch((err) => { if (live) setPropertiesError(facilitiesErrorMessage(err)); });
    return () => { live = false; };
  }, [auth?.organizationId]);

  const visible = filter === "all" ? customers : customers.filter((customer) => customer.kind === filter);
  const empty = !loading && visible.length === 0
    ? (customers.length === 0 ? "This company has no service customers yet." : "No customers in this list.")
    : "";

  return (
    <CompanyShell title={companyName || "Management home"}>
      {error && <p className="c04-error" role="alert">{error}</p>}
      {propertiesError && <p className="c04-error" role="alert">{propertiesError}</p>}
      <section className="c04-kpis" aria-label="Work that needs a look">
        <article className="c04-tile">
          <div className="lab">Open work orders</div>
          <div className="val">{loading ? "…" : counts.open_work_orders}</div>
          <div className="st">Across every customer you can see</div>
        </article>
        <article className="c04-tile">
          <div className="lab">Failed or overdue</div>
          <div className="val amber">{loading ? "…" : counts.failed_or_overdue}</div>
          <div className="st amber">Openings that failed or are past due</div>
        </article>
        <article className="c04-tile">
          <div className="lab">Inspections due</div>
          <div className="val">{loading ? "…" : counts.inspections_due_30_days}</div>
          <div className="st">Due in the next 30 days</div>
        </article>
        <article className="c04-tile">
          <div className="lab">Quotes</div>
          <div className="val">{loading ? "…" : counts.quotes}</div>
          <div className="st">Saved estimates. Approval is recorded on each quote.</div>
        </article>
      </section>
      <section className="c04-card">
        <div className="c04-band blue">
          <div>
            <h2>Customers</h2>
            <p>One list. Filter by the kind of account.</p>
          </div>
        </div>
        <div className="c04-body">
          <div className="c04-filters" aria-label="Customer filter">
            {(["all", "facility", "small", "walkin"] as KindFilter[]).map((kind) => (
              <button key={kind} type="button" aria-pressed={filter === kind} className={filter === kind ? "c04-chip on" : "c04-chip"} onClick={() => setFilter(kind)}>
                {kind === "all" ? "All" : kind === "facility" ? "Facility accounts" : kind === "small" ? "Small accounts" : "Walk-in"}
              </button>
            ))}
          </div>
          <p className="c04-note">{note}</p>
          {empty && <p className="c04-note">{empty}</p>}
          <div className="c04-stack" style={{ marginTop: 12 }}>
            {visible.map((customer) => (
              <Link key={customer.id} className="c04-row" to={`/customers/${customer.id}`}>
                <h3>{customer.name} <span className={customer.kind === "walkin" ? "c04-pill amber" : "c04-pill green"}>{customer.kind_label}</span></h3>
                <p>{customer.opening_count} openings</p>
                <p className={customer.attention_count ? "c04-amber" : undefined}>{customer.attention}</p>
                <p className="c04-note">{loc.label({ property_id: customer.property_ids[0], property_name: customer.name })}</p>
                <p className="c04-note">Last visit {formatDay(customer.last_visit)} · Next due {formatDay(customer.next_due)}</p>
              </Link>
            ))}
          </div>
          <details className="c04-menu">
            <summary>More company tools</summary>
            <p><Link to="/work-orders">Work orders</Link> · <Link to="/maintenance-schedules">Maintenance schedules</Link> · <Link to="/team">Team</Link> · <Link to="/inspection-visits">Inspection visits</Link></p>
          </details>
        </div>
      </section>
    </CompanyShell>
  );
}
