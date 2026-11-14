import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BackLink, CompanyShell, formatDay } from "../components/CompanyShell";
import { fetchCompanyCustomer, type CompanyCustomerDetail } from "../lib/api";
import { facilitiesErrorMessage } from "../lib/scheduleUi";

export function CompanyCustomerPage() {
  const { customerId = "" } = useParams();
  const [customer, setCustomer] = useState<CompanyCustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchCompanyCustomer(customerId)
      .then((row) => { if (live) setCustomer(row); })
      .catch((err) => { if (live) setError(facilitiesErrorMessage(err)); });
    return () => { live = false; };
  }, [customerId]);
  return (
    <CompanyShell title={customer?.name ?? "Customer"}>
      <BackLink to="/">Back to customers</BackLink>
      <p className="c04-note"><Link to="/">Customers</Link> · {customer?.name ?? "Customer"}</p>
      {error && <p className="c04-error" role="alert">{error}</p>}
      {customer && (
        <section className="c04-card">
          <div className={customer.kind === "walkin" ? "c04-band green" : "c04-band cyan"}>
            <div>
              <h2>{customer.name}</h2>
              <p>{customer.kind_label}. {customer.classification_note}</p>
            </div>
          </div>
          <div className="c04-body">
            <div className="c04-stack">
              {customer.sites.map((site) => (
                <Link key={site.id} className="c04-row" to={`/sites/${site.id}`}>
                  <h3>{site.name}</h3>
                  <p>{site.address || "Address not recorded"}</p>
                  <p>{site.opening_count} openings</p>
                  <p className={site.attention === "Nothing waiting" ? undefined : "c04-amber"}>{site.attention}</p>
                  <p className="c04-note">Last visit {formatDay(site.last_visit)} · Next due {formatDay(site.next_due)}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </CompanyShell>
  );
}
