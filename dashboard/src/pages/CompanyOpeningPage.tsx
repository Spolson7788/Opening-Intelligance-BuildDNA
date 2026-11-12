import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BackLink, CompanyShell, formatDay, formatMoney, plainType } from "../components/CompanyShell";
import { quoteStatus } from "./CompanySitePage";
import { fetchCompanyOpening, type CompanyOpening } from "../lib/api";
import { facilitiesErrorMessage } from "../lib/scheduleUi";

export function CompanyOpeningPage() {
  const { id = "" } = useParams();
  const [opening, setOpening] = useState<CompanyOpening | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchCompanyOpening(id)
      .then((row) => { if (live) setOpening(row); })
      .catch((err) => { if (live) setError(facilitiesErrorMessage(err)); });
    return () => { live = false; };
  }, [id]);
  return (
    <CompanyShell title={opening?.location_description || opening?.opening_code || "Opening"}>
      {opening && <BackLink to={`/sites/${opening.property_id}`}>Back to {opening.property_name}</BackLink>}
      {error && <p className="c04-error" role="alert">{error}</p>}
      {opening && (
        <>
          <p className="c04-note">
            <Link to="/">Customers</Link>
            {opening.customer_name !== opening.property_name && <> · <Link to={`/customers/${opening.customer_id}`}>{opening.customer_name}</Link></>}
            {" "}· <Link to={`/sites/${opening.property_id}`}>{opening.property_name}</Link> · {opening.opening_code}
          </p>
          <section className="c04-kpis" aria-label="This opening">
            <article className="c04-tile">
              <div className="lab">Opening</div>
              <div className="val" style={{ fontSize: 22 }}>{opening.location_description || opening.opening_code}</div>
              <div className="st">{plainType(opening.opening_type)} · {opening.kind_label}</div>
            </article>
            <article className="c04-tile">
              <div className="lab">Condition</div>
              <div className={opening.needs_attention ? "val amber" : "val"}>{opening.needs_attention ? "Failed" : "On file"}</div>
              <div className="st">{opening.health_score === null ? "Health score not recorded" : `Health score ${opening.health_score}`}</div>
            </article>
            <article className="c04-tile">
              <div className="lab">Quote</div>
              <div className="val" style={{ fontSize: 22 }}>{opening.quotes[0] ? formatMoney(opening.quotes[0].total_minor) : "—"}</div>
              <div className="st">
                {opening.quotes[0] ? quoteStatus(opening.quotes[0].approval_status) : "No saved estimate."}
                {opening.quotes[0] && <> <Link to={`/sites/${opening.property_id}?tab=work`}>Change it on the site's Work & quotes tab.</Link></>}
              </div>
            </article>
          </section>
          <section className="c04-card">
            <div className="c04-band blue">
              <div>
                <h2>{opening.opening_code}</h2>
                <p>One opening page for facility accounts, small accounts, and walk-in.</p>
              </div>
            </div>
            <div className="c04-body">
              <div className="c04-tabs">
                <Link className="c04-tab" to={`/sites/${opening.property_id}`}>Openings</Link>
                <span className="c04-tab">Visits</span>
                <span className="c04-tab on">Work & quotes</span>
                <span className="c04-tab">Purchasing</span>
              </div>
              <div className="c04-stack" style={{ marginTop: 12 }}>
                {opening.work_records.length === 0 && <p className="c04-note">No service recorded on this opening.</p>}
                {opening.work_records.map((record) => (
                  <article key={record.id} className="c04-row">
                    <h3>{record.label}</h3>
                    <p>Performed {formatDay(record.performed_on)}. Advised {formatDay(record.advised_on)}.</p>
                  </article>
                ))}
                {opening.quotes.map((quote) => (
                  <article key={quote.id} className="c04-row">
                    <h3>Estimate</h3>
                    <p>{formatMoney(quote.total_minor)}</p>
                    <p className="c04-note">{quoteStatus(quote.approval_status)}. <Link to={`/sites/${opening.property_id}?tab=work`}>Change it on the site's Work & quotes tab.</Link> Nothing is sent or ordered from this page.</p>
                  </article>
                ))}
              </div>
              <details className="c04-menu">
                <summary>Purchasing details</summary>
                <p className="c04-note">Review only. Nothing here approves a purchase or sends a payment.</p>
                <p><Link to={`/opening/${opening.id}`}>Open the full opening record</Link></p>
              </details>
            </div>
          </section>
        </>
      )}
    </CompanyShell>
  );
}
