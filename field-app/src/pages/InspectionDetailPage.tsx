import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchOpening } from "../lib/api";
import { EmailInspectionReport } from "../components/EmailInspectionReport";
import { NFPA80_ITEMS } from "../lib/nfpa80Items";
import { SyncBadge } from "../components/SyncBadge";

export function InspectionDetailPage() {
  const { id, eventId } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState<any | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    fetchOpening(id!).then(({ opening }) => {
      if (!live) return;
      const found = (opening.inspection_events || []).find((row: { id: string }) => row.id === eventId) ?? null;
      setEvent(found);
      setMissing(!found);
    }).catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [id, eventId]);

  const items = event?.checklist_result?.items ?? null;
  const fireDoor = event?.inspection_type === "fire_door_nfpa80" && event?.checklist_result?.status === "complete";

  return (
    <div className="app-shell c04">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate(`/opening/${id}`)}>
          ← Opening
        </button>
        <SyncBadge />
      </div>
      <div className="screen">
        {!event && !missing && <p role="status">Loading inspection.</p>}
        {missing && <p className="c04-alert" role="alert">This inspection is not on this opening.</p>}
        {event && (
          <>
            <section className="c04-band">
            <h2 style={{ marginBottom: 8 }}>Inspection</h2>
            <p>{new Date(event.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</p>
            <p style={{ textTransform: "capitalize" }}>{String(event.inspection_type || "general").replace(/_/g, " ")}</p>
            <p style={{ color: event.passed ? "var(--success)" : "var(--danger)", fontWeight: 700 }}>{event.passed ? "Passed" : "Failed"}</p>
            {event.signed_by_name && <p>Inspector {event.signed_by_name}</p>}
            {event.inspector_qualification && <p>Qualification {event.inspector_qualification}</p>}
            {event.inspector_license_number && <p>License {event.inspector_license_number}</p>}
            {event.notes && <p>Notes {event.notes}</p>}
            {event.signature_data && <img src={event.signature_data} alt="Inspection signature" style={{ display: "block", maxWidth: "100%", background: "#fff", margin: "8px 0" }} />}
            </section>
            {items && (
              <section className="c04-band-blue">
                <h3>Checklist</h3>
                {NFPA80_ITEMS.map((item) => (
                  <p key={item.key}>
                    <strong>{item.section}</strong> {item.text}
                    <br />
                    Result: {items[item.key]?.result || "—"}
                    {items[item.key]?.note ? ` — ${items[item.key].note}` : ""}
                  </p>
                ))}
              </section>
            )}
            {fireDoor && <EmailInspectionReport inspectionId={event.id} />}
            <Link to={`/opening/${id}`}>Back to the opening</Link>
          </>
        )}
      </div>
    </div>
  );
}
