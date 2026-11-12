import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BackLink, CompanyShell, formatDay, formatMoney, plainType } from "../components/CompanyShell";
import { downloadAuthedFile, fetchCompanySite, setQuoteApproval, type CompanySite } from "../lib/api";
import { facilitiesErrorMessage } from "../lib/scheduleUi";

type Tab = "openings" | "visits" | "work" | "purchasing";

function quoteStatus(status: string) {
  if (status === "awaiting_approval") return "Awaiting approval";
  if (status === "approved") return "Approved";
  if (status === "declined") return "Declined";
  return "Draft";
}

export function CompanySitePage() {
  const { propertyId = "" } = useParams();
  const [site, setSite] = useState<CompanySite | null>(null);
  const [tab, setTab] = useState<Tab>("openings");
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setSite(await fetchCompanySite(propertyId));
  }
  async function markQuote(id: string, approval_status: "awaiting_approval" | "approved" | "declined") {
    setError(null);
    try {
      await setQuoteApproval(id, approval_status);
      await reload();
    } catch (err) {
      setError(facilitiesErrorMessage(err));
    }
  }
  useEffect(() => {
    let live = true;
    fetchCompanySite(propertyId)
      .then((row) => { if (live) setSite(row); })
      .catch((err) => { if (live) setError(facilitiesErrorMessage(err)); });
    return () => { live = false; };
  }, [propertyId]);
  return (
    <CompanyShell title={site?.name ?? "Site"}>
      <BackLink to={site && site.customer_name !== site.name ? `/customers/${site.customer_id}` : "/"}>
        {site && site.customer_name !== site.name ? `Back to ${site.customer_name}` : "Back to customers"}
      </BackLink>
      <p className="c04-note">
        <Link to="/">Customers</Link>
        {site && site.customer_name !== site.name && <> · <Link to={`/customers/${site.customer_id}`}>{site.customer_name}</Link></>}
        {site && <> · {site.name}</>}
      </p>
      {error && <p className="c04-error" role="alert">{error}</p>}
      {site && (
        <section className="c04-card">
          <div className="c04-band cyan">
            <div>
              <h2>{site.name}</h2>
              <p>{site.kind_label}. {site.address || "Address not recorded"}</p>
            </div>
          </div>
          <div className="c04-body">
            <div className="c04-tabs" aria-label="Site sections">
              {([["openings", "Openings"], ["visits", "Visits"], ["work", "Work & quotes"], ["purchasing", "Purchasing"]] as [Tab, string][]).map(([key, label]) => (
                <button key={key} type="button" className={tab === key ? "c04-tab on" : "c04-tab"} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>
            {tab === "openings" && (
              <div className="c04-stack" style={{ marginTop: 12 }}>
                {site.openings.length === 0 && <p className="c04-note">No openings at this site.</p>}
                {site.openings.map((opening) => (
                  <Link key={opening.id} className="c04-row" to={`/company/opening/${opening.id}`}>
                    <h3>{opening.location_description || opening.opening_code} {opening.needs_attention && <span className="c04-pill amber">Failed</span>}</h3>
                    <p>{plainType(opening.opening_type)}{opening.fire_rated ? " · Fire-rated" : ""} · {opening.building_name}</p>
                    <p className="c04-note">{opening.opening_code}</p>
                  </Link>
                ))}
              </div>
            )}
            {tab === "visits" && (
              <div className="c04-stack" style={{ marginTop: 12 }}>
                {site.visits.length === 0 && <p className="c04-note">No stored visits for this site.</p>}
                {site.visits.map((visit) => (
                  <article key={visit.id} className="c04-row">
                    <h3>{formatDay(visit.visit_date)}</h3>
                    {visit.report_stored
                      ? <button type="button" className="c04-btn" onClick={() => downloadAuthedFile(`/company-dashboard/visits/${visit.id}/report.pdf`, "visit.pdf")}>Download visit PDF</button>
                      : <p className="c04-note">No stored PDF for this visit.</p>}
                  </article>
                ))}
              </div>
            )}
            {tab === "work" && (
              <div className="c04-stack" style={{ marginTop: 12 }}>
                {site.work_orders.length === 0 && <p className="c04-note">No open work orders at this site.</p>}
                {site.work_orders.map((order) => (
                  <article key={order.id} className="c04-row">
                    <h3>{order.title}</h3>
                    <p>{order.opening_code} · {order.status.replaceAll("_", " ")}</p>
                    <p className="c04-note">Due {formatDay(order.due_date)}</p>
                  </article>
                ))}
                {site.quotes.map((quote) => (
                  <article key={quote.id} className="c04-row">
                    <h3>Estimate · {quote.opening_code}</h3>
                    <p>{formatMoney(quote.total_minor)}</p>
                    <p className="c04-note">{quoteStatus(quote.approval_status)}. Approving here does not send a purchase.</p>
                    <div className="c04-actions">
                      <button type="button" className="c04-btn" onClick={() => markQuote(quote.id, "awaiting_approval")}>Awaiting approval</button>
                      <button type="button" className="c04-btn green" onClick={() => markQuote(quote.id, "approved")}>Approved</button>
                      <button type="button" className="c04-btn" onClick={() => markQuote(quote.id, "declined")}>Declined</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {tab === "purchasing" && (
              <div style={{ marginTop: 12 }}>
                <p>Review only. Nothing here approves a purchase or sends a payment.</p>
                {site.quotes.length === 0 && <p className="c04-note">No saved estimates for this site.</p>}
                {site.quotes.map((quote) => (
                  <article key={quote.id} className="c04-row">
                    <h3>{quote.opening_code}</h3>
                    <p>{formatMoney(quote.total_minor)}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </CompanyShell>
  );
}
