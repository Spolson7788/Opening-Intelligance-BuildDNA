import { Link } from "react-router-dom";

const items = [
  ["lifecycle", "History"],
  ["schedules", "Schedules"],
  ["", "Hardware"],
  ["structure", "Door and frame"],
  ["request-service", "Request service"],
] as const;

export function DetailsDrawer({ openingId, onClose }: { openingId: string; onClose: () => void }) {
  return (
    <div className="c04-details" role="dialog" aria-label="Details">
      <h2>Details</h2>
      <p className="c04-note">The inspection stays put behind this list.</p>
      {items.map(([path, label]) => (
        <Link key={label} className="btn c04-choice" to={path ? `/opening/${openingId}/${path}` : `/opening/${openingId}`} onClick={onClose}>{label}</Link>
      ))}
      <button type="button" className="btn c04-choice" onClick={onClose}>Close</button>
    </div>
  );
}
