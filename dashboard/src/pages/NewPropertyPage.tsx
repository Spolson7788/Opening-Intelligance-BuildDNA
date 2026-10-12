import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { listPortfolios, createProperty, createBuilding } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

const PROPERTY_TYPES = [
  { value: "multifamily", label: "Multifamily" },
  { value: "senior_living", label: "Senior Living" },
  { value: "healthcare", label: "Healthcare" },
  { value: "university", label: "University" },
  { value: "hospitality", label: "Hospitality" },
  { value: "other", label: "Other" },
];

export function NewPropertyPage() {
  const navigate = useNavigate();
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);

  // Step 1: property details
  const [name, setName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [propertyType, setPropertyType] = useState("multifamily");
  const [submittingProperty, setSubmittingProperty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 2: buildings, once the property exists
  const [createdProperty, setCreatedProperty] = useState<{ id: string; name: string } | null>(null);
  const [buildingName, setBuildingName] = useState("");
  const [addedBuildings, setAddedBuildings] = useState<{ id: string; name: string }[]>([]);
  const [submittingBuilding, setSubmittingBuilding] = useState(false);

  useEffect(() => {
    listPortfolios()
      .then((portfolios) => {
        // Portfolios aren't a concept surfaced anywhere else in this app —
        // every org has exactly one by default (created at signup) — so we
        // just use the first one rather than asking the user to pick.
        if (portfolios.length > 0) setPortfolioId(portfolios[0].id);
        else setError("No portfolio found for your organization — contact support.");
      })
      .catch(() => setError("Couldn't load your portfolio. Check your connection and try again."))
      .finally(() => setLoadingPortfolio(false));
  }, []);

  async function onCreateProperty(e: FormEvent) {
    e.preventDefault();
    if (!portfolioId) return;
    setSubmittingProperty(true);
    setError(null);
    try {
      const property = await createProperty({
        portfolio_id: portfolioId,
        name,
        address_line1: addressLine1 || undefined,
        city: city || undefined,
        state: state || undefined,
        postal_code: postalCode || undefined,
        property_type: propertyType,
      });
      setCreatedProperty({ id: property.id, name: property.name });
    } catch {
      setError("Couldn't create the property. Check your connection and try again.");
    } finally {
      setSubmittingProperty(false);
    }
  }

  async function onAddBuilding(e: FormEvent) {
    e.preventDefault();
    if (!createdProperty || !buildingName.trim()) return;
    setSubmittingBuilding(true);
    setError(null);
    try {
      const building = await createBuilding({ property_id: createdProperty.id, name: buildingName.trim() });
      setAddedBuildings((prev) => [...prev, building]);
      setBuildingName("");
    } catch {
      setError("Couldn't add that building. Check your connection and try again.");
    } finally {
      setSubmittingBuilding(false);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main" style={{ maxWidth: 560 }}>
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        {!createdProperty ? (
          <div className="panel">
            <h2 style={{ marginBottom: 16 }}>New Property</h2>
            {loadingPortfolio ? (
              <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>
            ) : (
              <form onSubmit={onCreateProperty}>
                <div className="field">
                  <label htmlFor="name">Property name</label>
                  <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sunset Ridge Apartments" required />
                </div>
                <div className="field">
                  <label htmlFor="address-line1">Street address</label>
                  <input id="address-line1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} placeholder="e.g. 4200 Sunset Ridge Dr" />
                </div>
                <div className="field">
                  <label htmlFor="city">City</label>
                  <input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="state">State</label>
                    <input id="state" value={state} onChange={(e) => setState(e.target.value)} placeholder="e.g. AZ" maxLength={2} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="postal-code">Zip code</label>
                    <input id="postal-code" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="e.g. 85040" maxLength={10} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="property-type">Property type</label>
                  <select id="property-type" value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
                    {PROPERTY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                {error && <p className="error-text">{error}</p>}
                <button type="submit" className="btn btn-primary" disabled={submittingProperty || !portfolioId}>
                  {submittingProperty ? "Creating…" : "Create Property"}
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="panel">
            <h2 style={{ marginBottom: 4 }}>{createdProperty.name}</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20 }}>
              Property created. Add at least one building before you can create openings under it.
            </p>

            {addedBuildings.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {addedBuildings.map((b) => (
                  <div key={b.id} className="asset-plate" style={{ marginBottom: 8, display: "inline-flex", marginRight: 8 }}>
                    {b.name}
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={onAddBuilding} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 20 }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label htmlFor="building-name">Building name</label>
                <input
                  id="building-name"
                  value={buildingName}
                  onChange={(e) => setBuildingName(e.target.value)}
                  placeholder="e.g. Building A"
                />
              </div>
              <button type="submit" className="btn" style={{ width: "auto", height: 42 }} disabled={submittingBuilding || !buildingName.trim()}>
                {submittingBuilding ? "Adding…" : "Add"}
              </button>
            </form>
            {error && <p className="error-text">{error}</p>}

            <button className="btn btn-primary" onClick={() => navigate("/")} disabled={addedBuildings.length === 0}>
              {addedBuildings.length === 0 ? "Add at least one building to continue" : "Done — Back to Portfolio"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
