import { useEffect,useState } from "react";
import { Link,useParams } from "react-router-dom";
import { fetchOpeningLabel } from "../lib/api";
interface Label {qr_data_url:string;payload:string;opening_code:string;facility_name:string;building_name:string;completion_state:string}
export function QrLabelPage(){
 const {id}=useParams();const [label,setLabel]=useState<Label|null>(null);const [error,setError]=useState("");
 useEffect(()=>{if(id)fetchOpeningLabel(id).then((row:Label)=>{if(row.completion_state!=="complete")throw new Error("not_complete");setLabel(row);}).catch(()=>setError("A connected, finished opening is required. Return to the opening and verify its saved state."));},[id]);
 return <div className="screen qr-print-page"><div className="no-print"><Link to={`/opening/${id}`}>Back to opening</Link><h1>Opening label</h1><p>Letter paper, portrait, 100% scale; browser headers and footers off. Label: 2.4 inches wide, at least 3 inches high. Save as PDF or choose your printer.</p>{error&&<p role="alert">{error}</p>}{label&&<button className="btn btn-primary" onClick={()=>window.print()}>Print / save label</button>}</div>
 {label&&<div className="opening-print-label"><div>{label.facility_name}</div><div>{label.building_name}</div><strong>{label.opening_code}</strong><img src={label.qr_data_url} alt={`QR for ${label.opening_code}`}/><small>Sign-in and authorized facility access required.</small></div>}</div>;
}
