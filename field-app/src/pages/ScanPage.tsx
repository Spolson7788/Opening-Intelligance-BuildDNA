import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Html5Qrcode } from "html5-qrcode";
import { SyncBadge } from "../components/SyncBadge";
import { useAuth } from "../lib/AuthContext";

const SCANNER_ELEMENT_ID = "qr-reader";

export function ScanPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [manualCode, setManualCode] = useState("");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID);
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          // Payload is a URL like https://app.openingintel.com/scan/<token> — extract the token.
          const token = decodedText.split("/").pop() || decodedText;
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
    <div className="app-shell">
      <div className="top-bar">
        <h1>Scan Opening</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SyncBadge />
        </div>
      </div>
      <div className="screen">
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <div id={SCANNER_ELEMENT_ID} style={{ width: "100%" }} />
        </div>
        {cameraError && <p className="error-text">{cameraError}</p>}

        <div className="section-label" style={{ marginTop: 24 }}>Or enter the opening code</div>
        <form onSubmit={onManualSubmit}>
          <div className="field">
            <label htmlFor="manual-code">Opening code (from the door tag)</label>
            <input
              id="manual-code"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="e.g. AZ-PHX-BLDG03-F02-0214"
            />
          </div>
          <button type="submit" className="btn btn-secondary">Look Up</button>
        </form>

        <button
          className="btn btn-secondary"
          style={{ marginTop: 24 }}
          onClick={() => navigate("/my-work-orders")}
        >
          My Work Orders
        </button>

        <button
          className="btn btn-secondary"
          style={{ marginTop: 12, color: "var(--text-secondary)" }}
          onClick={() => logout()}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
