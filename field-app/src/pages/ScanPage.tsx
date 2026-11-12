import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Html5Qrcode } from "html5-qrcode";
import { SyncBadge } from "../components/SyncBadge";
import { FacilitySelector } from "../components/FacilitySelector";
import { useAuth } from "../lib/AuthContext";
import { parseOpeningQr } from "../lib/qrPayload";
import { facilityDashboardMenuVisible, fetchInspectionVisit, fetchLabelConfig, fetchOpenInspectionVisit } from '../lib/api';
import { showFacilityDashboardShortcut, tokenHasVerifiedStaffSession } from '../lib/facilityDashboardReturn';
import { getSyncOperationsForPrincipal, loadAuth } from "../lib/db";
import { openingCountText, pendingInspectionIds, reconcileOpenVisit, startNewVisit, visitCounts, visitSummaryText, visitUploadMessage } from "../lib/inspectionVisit";
import type { InspectionVisit } from "../lib/inspectionVisit";

const SCANNER_ELEMENT_ID = "qr-reader";

function FacilityDashboardLink() {
  const { auth } = useAuth();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    setShow(false);
    if (!auth || !tokenHasVerifiedStaffSession(auth.token)) return;
    void facilityDashboardMenuVisible().then((allowed) => {
      if (live) setShow(showFacilityDashboardShortcut({ mfaVerified: true, staff: allowed, allowed, role: auth.role }));
    });
    return () => { live = false; };
  }, [auth?.userId, auth?.organizationId, auth?.token, auth?.role]);
  if (!show) return null;
  return <a className="btn c04-choice" href="/facility-dashboard/">Facility Dashboard</a>;
}

export function ScanPage() {
  const navigate = useNavigate();
  const { logout,auth,logoutPending,logoutError } = useAuth();
  const canonicalBase=useRef('');
  const [manualCode, setManualCode] = useState("");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [scanning, setScanning] = useState(false);
  const [visit, setVisit] = useState<InspectionVisit | null>(null);
  const [visitNote, setVisitNote] = useState<string | null>(null);
  const [confirmNewVisit, setConfirmNewVisit] = useState(false);
  useEffect(() => {
    let live = true;
    void reconcileOpenVisit((id) => fetchInspectionVisit(id), fetchOpenInspectionVisit).then((open) => { if (live) setVisit(open); });
    return () => { live = false; };
  }, []);

  async function beginNewVisit() {
    const current = visit;
    let pending = 0;
    if (current) {
      let serverIds: string[] | null = null;
      try {
        const row = await fetchInspectionVisit(current.id);
        serverIds = row.inspection_ids ?? [];
      } catch { serverIds = null; }
      const auth = await loadAuth();
      const operations = auth ? await getSyncOperationsForPrincipal(auth.userId, auth.organizationId) : [];
      pending = pendingInspectionIds(current.inspections.map((item) => item.inspectionId), operations, serverIds).length;
    }
    await startNewVisit();
    setVisit(null);
    setVisitNote(pending ? `${visitUploadMessage(pending)} They stay in Synchronization review and were not removed.` : null);
  }

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
      <div className="c04-toolbar">
        <p className="c04-kicker">Field app</p>
        <SyncBadge />
      </div>
      <div className="screen">
        <h1>Scan opening</h1>
        {visit && <div className="c04-band-green">
          <p role="status">{visitSummaryText(visit.inspections)}</p>
          <button type="button" className="btn c04-btn-blue c04-visit-finish" onClick={() => navigate(`/visit/${visit.id}`)}>Finish visit / Send combined report</button>
        </div>}
        {visitNote && <p className="c04-note" role="status">{visitNote}</p>}
        <button type="button" className="btn c04-btn-cyan" onClick={() => navigate("/choose-location")}>Change facility</button>
        {confirmNewVisit && visit ? <section className="c04-panel" role="dialog" aria-labelledby="start-new-visit-title">
          <h2 id="start-new-visit-title">Start a new visit?</h2>
          <p>This visit has {openingCountText(visitCounts(visit.inspections).inspected)} and stays open and unfinished. Nothing is discarded.</p>
          <button type="button" className="btn c04-btn-blue" onClick={() => navigate(`/visit/${visit.id}`)}>Finish this visit first</button>
          <button type="button" className="btn c04-visit-secondary" onClick={() => { setConfirmNewVisit(false); void beginNewVisit(); }}>Start a new visit anyway</button>
          <button type="button" className="btn c04-choice" onClick={() => setConfirmNewVisit(false)}>Not now</button>
        </section> : <button type="button" className="btn c04-visit-secondary" onClick={() => { if (visit) setConfirmNewVisit(true); else void beginNewVisit(); }}>Start a new visit</button>}
        <FacilitySelector />
        <section className="c04-band" aria-label="Scan or enter an opening code">
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
        </section>
        <button className="btn c04-btn-cyan" onClick={() => navigate("/setup-opening")}>Facilities and openings</button>
        <button className="btn c04-btn-green" onClick={() => navigate("/today-route")}>Today's route</button>
        <button className="btn c04-btn-green" onClick={() => navigate("/my-work-orders")}>My Work Orders</button>
        <FacilityDashboardLink />
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
