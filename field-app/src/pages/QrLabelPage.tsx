import { Link, useParams } from "react-router-dom";
import { showLabelPreview } from "../../../facility-dashboard/labels.mjs";
export function QrLabelPage() {
  const { id } = useParams();
  return <div className="app-shell c04"><div className="screen"><Link to={`/opening/${id}`}>Back to opening</Link>
    <h1>Opening label</h1><section className="c04-band"><p>A connected, complete opening is required. Preview reports any missing requirements.</p>
    <button className="btn btn-primary" onClick={() => id && void showLabelPreview([{ id }])}>Preview / reprint label</button></section>
  </div></div>;
}
