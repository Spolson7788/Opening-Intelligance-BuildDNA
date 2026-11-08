import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Html5Qrcode } from "html5-qrcode";
import { FieldBrand } from "../components/FieldBrand";
import { SyncBadge } from "../components/SyncBadge";
import { FacilitySelector } from "../components/FacilitySelector";
import { useAuth } from "../lib/AuthContext";
import { parseOpeningQr } from "../lib/qrPayload";
import { fetchLabelConfig } from '../lib/api';

const SCANNER_ELEMENT_ID = "qr-reader";

export function ScanPage() {
  const navigate = useNavigate();
  const { logout,auth,logoutPending,logoutError } = useAuth();
  const canonicalBase=useRef('');
  const [manualCode, setManualCode] = useState("");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    document.body.classList.add("c04-on");
    return () => document.body.classList.remove("c04-on");
  }, []);

  useEffect(() => {
    let active=true;
    if(auth)fetchLabelConfig(auth).then(config=>{if(active)canonicalBase.current=config.field_base;}).catch(()=>{if(active)setCameraError('Label configuration unavailable. Reconnect and reload, or enter the opening code.');});
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID);
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          // Accept canonical same-site labels and the original opaque-token format.
          const token = parseOpeningQr(decodedText, canonicalBase.current);
          if (!token) { setCameraError("This is not a supported opening label. Use the opening code below."); return; }
          handleScanned(token);
        },
        () => {
          // per-frame scan failures are expected constantly while aiming — ignore
        }
      )
      .then(() => setScanning(true))
      .catch((err) => {
        setCameraError("Camera unavailable — use manual entry below.");
        console.error(err);
      });

    return () => {
      active=false;
      if (scannerRef.current && scanning) {
        scannerRef.current.stop().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleScanned(qrToken: string) {
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => {});
    }
    navigate(`/opening/by-qr/${encodeURIComponent(qrToken)}`);
  }

  function onManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (manualCode.trim()) navigate(`/opening/by-code/${encodeURIComponent(manualCode.trim())}`);
  }

  return (
    <div className="app-shell c04">
      <FieldBrand />
      <div className="c04-toolbar">
        <p className="c04-kicker">Field app</p>
        <SyncBadge />
      </div>
      <div className="screen">
        <h1>Scan opening</h1>
        <FacilitySelector />
        <h2>Scan or enter an opening code</h2>
        <div className="c04-scan">
          <div id={SCANNER_ELEMENT_ID} />
          <span className="c04-finder" aria-hidden="true" />
        </div>
        {cameraError && <p className="c04-alert" role="alert">{cameraError}</p>}
        <p className="c04-note">Lookup requires a connection. A QR label does not grant access.</p>
        <form onSubmit={onManualSubmit}>
          <div className="field">
            <label htmlFor="manual-code">Opening code</label>
            <input
              id="manual-code"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="Enter the code from the door tag"
            />
          </div>
          <button type="submit" className="btn c04-btn-blue">Look up opening</button>
        </form>
        <button className="btn c04-btn-cyan" onClick={() => navigate("/setup-opening")}>Facilities and openings</button>
        <button className="btn c04-btn-green" onClick={() => navigate("/my-work-orders")}>My Work Orders</button>
        <a className="btn c04-btn-cyan" href="/facility-dashboard/">Facility Dashboard</a>
        <Link className="btn c04-choice" to="/how-to-use">How to use</Link>
        <button type="button" className="btn c04-choice" onClick={() => navigate("/change-password")}>Change Password</button>
        <button type="button" className="btn c04-choice" disabled={logoutPending} onClick={() => logout()}>
          {logoutPending ? "Signing out…" : "Sign Out"}
        </button>
        {logoutPending && <p role="status">Signing out. Your saved changes remain on this device.</p>}
        {logoutError && <p className="c04-alert" role="alert">{logoutError}</p>}
      </div>
    </div>
  );
}
