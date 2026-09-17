import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { addHardwareComponent, fetchOpening } from "../lib/api";
import { CARRIER_OPTIONS } from "../lib/tracking";
import { SyncBadge } from "../components/SyncBadge";

const COMPONENT_TYPES = [
  { value: "lockset", label: "Lockset" },
  { value: "cylinder", label: "Cylinder" },
  { value: "closer", label: "Closer" },
  { value: "exit_device", label: "Exit Device" },
  { value: "hinge", label: "Hinge" },
  { value: "automatic_operator", label: "Automatic Operator" },
  { value: "panic_bar", label: "Panic Bar" },
  { value: "access_control_reader", label: "Access Control Reader" },
  { value: "keypad", label: "Keypad" },
  { value: "electric_strike", label: "Electric Strike" },
  { value: "power_transfer", label: "Power Transfer" },
  { value: "maglock", label: "Maglock" },
  { value: "request_to_exit_device", label: "Request-to-Exit Device" },
  { value: "other", label: "Other" },
];

const SHIPMENT_STATUSES = [
  { value: "not_shipped", label: "Not shipped" },
  { value: "ordered", label: "Ordered" },
  { value: "shipped", label: "Shipped" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "installed", label: "Installed" },
  { value: "other", label: "Other" },
];

export function LogHardwarePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [componentType, setComponentType] = useState("lockset");
  const [manufacturer, setManufacturer] = useState("");
  const [modelNumber, setModelNumber] = useState("");
  const [installDate, setInstallDate] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierContact, setSupplierContact] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipmentStatus, setShipmentStatus] = useState("not_shipped");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [opening, setOpening] = useState<any>(null);
  const [mountingScope, setMountingScope] = useState("opening");
  const [doorLeafId, setDoorLeafId] = useState("");
  const [positionLabel, setPositionLabel] = useState("");
  const [condition, setCondition] = useState("unverified");
  const [identityStatus, setIdentityStatus] = useState("unresolved");
  const [reviewState, setReviewState] = useState("pending");
  const [replacementRequired, setReplacementRequired] = useState(false);

  useEffect(() => {
    if (id) fetchOpening(id).then((result) => setOpening(result.opening)).catch(() => undefined);
  }, [id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // This one requires connectivity — hardware capture isn't queued offline
      // yet (unlike service/inspection events), since it's typically a one-time
      // setup step done during initial capture, not a routine field action.
      await addHardwareComponent({
        opening_id: id,
        component_type: componentType,
        manufacturer: manufacturer || undefined,
        model_number: modelNumber || undefined,
        install_date: installDate || undefined,
        unit_cost: unitCost ? Number(unitCost) : undefined,
        supplier_name: supplierName || undefined,
        supplier_contact: supplierContact || undefined,
        serial_number: serialNumber || undefined,
        carrier: carrier || undefined,
        tracking_number: trackingNumber || undefined,
        shipment_status: shipmentStatus,
        mounting_scope: mountingScope,
        door_leaf_id: mountingScope === "door_leaf" ? doorLeafId : undefined,
        frame_id: mountingScope === "frame" ? opening?.frame?.id : undefined,
        position_label: positionLabel || undefined,
        client_operation_id: crypto.randomUUID(),
        condition,
        identity_status: identityStatus,
        review_state: reviewState,
        replacement_required: replacementRequired,
      });
      setSaved(true);
      setTimeout(() => navigate(`/opening/${id}`), 700);
    } catch {
      setError("Couldn't save — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <SyncBadge />
      </div>
      <div className="screen">
        <h2 style={{ marginBottom: 4 }}>Add Hardware</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 20 }}>
          Requires a connection — this is typically done during initial capture. A tracker ID is assigned
          automatically once saved.
        </p>

        {saved ? (
          <div className="card" style={{ textAlign: "center", color: "var(--success)" }}>
            Saved. Returning to the opening…
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="component-type">Component type</label>
              <select id="component-type" value={componentType} onChange={(e) => setComponentType(e.target.value)}>
                {COMPONENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mounting-scope">Installed on</label>
              <select id="mounting-scope" value={mountingScope} onChange={(e) => setMountingScope(e.target.value)}>
                <option value="opening">Overall opening</option>
                <option value="frame" disabled={!opening?.frame}>Frame</option>
                <option value="door_leaf" disabled={!opening?.door_leaves?.length}>Door leaf</option>
              </select>
            </div>
            {mountingScope === "door_leaf" && <div className="field">
              <label htmlFor="door-leaf">Door leaf</label>
              <select id="door-leaf" value={doorLeafId} onChange={(e) => setDoorLeafId(e.target.value)} required>
                <option value="">Select a leaf</option>
                {(opening?.door_leaves || []).map((leaf: any) => <option key={leaf.id} value={leaf.id}>{leaf.leaf_role}</option>)}
              </select>
            </div>}
            <div className="field">
              <label htmlFor="position-label">Position (when more than one exists)</label>
              <input id="position-label" value={positionLabel} onChange={(e) => setPositionLabel(e.target.value)} placeholder="e.g. top, middle, bottom" />
            </div>
            <div className="field"><label htmlFor="condition">Condition</label><select id="condition" value={condition} onChange={(e) => setCondition(e.target.value)}><option value="unverified">Unverified</option><option value="good">Good</option><option value="worn">Worn</option><option value="failed">Failed</option></select></div>
            <div className="field"><label htmlFor="identity-status">Product identity</label><select id="identity-status" value={identityStatus} onChange={(e) => setIdentityStatus(e.target.value)}><option value="unresolved">Unresolved</option><option value="established">Established</option></select></div>
            <div className="field"><label htmlFor="review-state">Review</label><select id="review-state" value={reviewState} onChange={(e) => setReviewState(e.target.value)}><option value="pending">Pending</option><option value="reviewed">Reviewed</option></select></div>
            <label style={{ display: "flex", gap: 8, marginBottom: 16 }}><input type="checkbox" checked={replacementRequired} onChange={(e) => setReplacementRequired(e.target.checked)} />Replacement required</label>
            <div className="field">
              <label htmlFor="manufacturer">Manufacturer</label>
              <input id="manufacturer" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="e.g. Cal-Royal" />
            </div>
            <div className="field">
              <label htmlFor="model-number">Model / part number</label>
              <input id="model-number" value={modelNumber} onChange={(e) => setModelNumber(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="serial-number">Serial number (from the physical part, if visible)</label>
              <input id="serial-number" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="e.g. SC-88213-A" />
            </div>
            <div className="field">
              <label htmlFor="install-date">Install date (if known)</label>
              <input id="install-date" type="date" value={installDate} onChange={(e) => setInstallDate(e.target.value)} />
            </div>

            <div className="section-label" style={{ marginTop: 4 }}>Replacement info (optional)</div>
            <div className="field">
              <label htmlFor="unit-cost">Replacement cost ($)</label>
              <input
                id="unit-cost"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="e.g. 340.50"
              />
            </div>
            <div className="field">
              <label htmlFor="supplier-name">Supplier / vendor</label>
              <input id="supplier-name" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="e.g. Southwest Security Supply" />
            </div>
            <div className="field">
              <label htmlFor="supplier-contact">Supplier contact (phone/email)</label>
              <input id="supplier-contact" value={supplierContact} onChange={(e) => setSupplierContact(e.target.value)} placeholder="e.g. (602) 555-0134" />
            </div>

            <div className="section-label" style={{ marginTop: 4 }}>Shipment tracking (optional)</div>
            <div className="field">
              <label htmlFor="shipment-status">Status</label>
              <select id="shipment-status" value={shipmentStatus} onChange={(e) => setShipmentStatus(e.target.value)}>
                {SHIPMENT_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="carrier">Carrier</label>
              <select id="carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                {CARRIER_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tracking-number">Tracking number</label>
              <input id="tracking-number" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="e.g. 1Z999AA10123456784" />
            </div>

            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
