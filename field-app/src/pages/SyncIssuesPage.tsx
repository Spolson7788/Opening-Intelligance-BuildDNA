import { useEffect, useState } from "react";
import { syncIssueCanDiscard, syncIssueMessage } from "../lib/syncIssueMessage";
import { useAuth } from "../lib/AuthContext";
import { useNavigate } from "react-router-dom";
import { discardPermanentFailure, getOfflineMedia, getOfflineMediaForPrincipal, getOpenConflictsForPrincipal, getSyncOperationsForPrincipal, loadAuth, recoverOrphanedMediaOperation, removeRejectedMedia, replaceRejectedMediaWithReducedCopy, requeueFinishedVisitInspection, retrySyncOperationAfterReview } from "../lib/db";
import { startNewVisit } from "../lib/inspectionVisit";
import { checksumBlob, flushOutbox } from "../lib/sync";
import { syncIssuesForRecords } from "../lib/syncIssuesModel";
import type { SyncIssueView } from "../lib/syncIssuesModel";
import { formatMegabytes, maximumMediaBytes } from "../lib/mediaLimits";
import { prepareImageForUpload, reducedFilename } from "../lib/photoPreparation";

function retryLabel(issue: SyncIssueView): string {
  if (issue.conflict) return "Keep local change and retry";
  if (issue.kind === "orphaned_media") return "Restore upload operation";
  if (issue.status === "in_flight" || issue.status === "verifying") return "Recover interrupted operation";
  if (issue.status === "retry_wait" && !syncIssueCanDiscard(issue)) return "Retry retained operation";
  if (syncIssueCanDiscard(issue)) return "Retry this saved change";
  return "Retry after authorization is restored";
}

export function SyncIssuesPage() {
  const { auth, identityChecking } = useAuth();
  const principal = auth ? `${auth.organizationId}/${auth.userId}` : "";
  const [loadedPrincipal, setLoadedPrincipal] = useState<string | null>(null);
  const navigate = useNavigate();
  const [issues, setIssues] = useState<SyncIssueView[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  async function load() {
    setLoadError(false);
    const auth = await loadAuth();
    if (!auth) { setIssues([]); setLoadedPrincipal(""); return; }
    try {
      const [operations, conflicts, media] = await Promise.all([
        getSyncOperationsForPrincipal(auth.userId, auth.organizationId),
        getOpenConflictsForPrincipal(auth.userId, auth.organizationId),
        getOfflineMediaForPrincipal(auth.userId, auth.organizationId),
      ]);
      const latest = await loadAuth();
      if (latest?.userId !== auth.userId || latest?.organizationId !== auth.organizationId) return;
      setIssues(syncIssuesForRecords(operations, conflicts, media));
      setLoadedPrincipal(`${auth.organizationId}/${auth.userId}`);
    } catch {
      setIssues([]);
      setLoadError(true);
      setLoadedPrincipal(`${auth.organizationId}/${auth.userId}`);
    }
  }

  useEffect(() => { void load(); }, [principal]);

  const note = (id: string, text: string) => setNotes((current) => ({ ...current, [id]: text }));

  async function keepFinishedVisitInspection(issue: SyncIssueView, mode: "standalone" | "new") {
    setBusy(issue.id);
    try {
      const visitId = mode === "new" ? (await startNewVisit())?.id ?? null : null;
      if (mode === "new" && !visitId) {
        note(issue.id, "Choose a facility before starting a new visit. This inspection is still on this device.");
        return;
      }
      await requeueFinishedVisitInspection(issue.id, visitId);
      await flushOutbox();
      await load();
    } catch (error) {
      note(issue.id, error instanceof Error ? error.message : "This inspection is still on this device.");
    } finally { setBusy(null); }
  }

  async function retry(issue: SyncIssueView) {
    if (issue.kind === "orphaned_media") await recoverOrphanedMediaOperation(issue.id);
    else await retrySyncOperationAfterReview(issue.id, issue.conflict);
    await flushOutbox();
    await load();
  }

  async function reduceAndUpload(issue: SyncIssueView) {
    if (!issue.photoId) return;
    setBusy(issue.id);
    try {
      const media = await getOfflineMedia(issue.photoId);
      if (!media) throw new Error("This photograph is no longer stored on this device.");
      const limit = maximumMediaBytes(media.contentType);
      const prepared = await prepareImageForUpload(media.blob, limit);
      if (!prepared.withinLimit) {
        note(issue.id, prepared.reason === "decode_failed"
          ? "This device cannot open this photograph's format to make a smaller copy. Save a copy to this device and add it again from a format the camera can share as JPEG."
          : `A copy under ${formatMegabytes(limit)} could not be made. Save a copy to this device before removing it.`);
        return;
      }
      await replaceRejectedMediaWithReducedCopy(issue.photoId, {
        blob: prepared.blob, contentType: prepared.contentType, byteSize: prepared.blob.size,
        sha256Checksum: await checksumBlob(prepared.blob),
        filename: prepared.reduced ? reducedFilename(media.originalFilename) : media.originalFilename,
        widthPixels: prepared.width, heightPixels: prepared.height,
      });
      await flushOutbox();
      await load();
    } catch (error) {
      note(issue.id, error instanceof Error ? error.message : "The smaller copy could not be saved.");
    } finally { setBusy(null); }
  }

  async function saveCopy(issue: SyncIssueView) {
    if (!issue.photoId) return;
    const media = await getOfflineMedia(issue.photoId);
    if (!media) { note(issue.id, "This photograph is no longer stored on this device."); return; }
    const url = URL.createObjectURL(media.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = media.originalFilename || media.generatedCaptureName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    note(issue.id, `A copy named ${link.download} was offered to this device's downloads.`);
  }

  async function discard(issue: SyncIssueView) {
    setBusy(issue.id);
    try {
      await discardPermanentFailure(issue.id);
      setConfirmRemove(null);
      await flushOutbox();
      await load();
    } catch (error) {
      note(issue.id, error instanceof Error ? error.message : "This change could not be discarded.");
    } finally { setBusy(null); }
  }

  async function remove(issue: SyncIssueView) {
    if (!issue.photoId) return;
    await removeRejectedMedia(issue.photoId);
    setConfirmRemove(null);
    await flushOutbox();
    await load();
  }

  return <div className="app-shell c04">
    <div className="top-bar"><button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button></div>
    <div className="screen">
      <section className="c04-band"><h2>Synchronization review</h2>
      <p>Entries remain stored on this device until synchronization succeeds. Review conflicts before retrying.</p></section>
      {loadError ? <div className="c04-alert" role="alert"><p>Saved changes on this device could not be read. They were not removed.</p><button type="button" className="btn btn-secondary" onClick={() => { void load(); }}>Retry</button></div> : identityChecking || loadedPrincipal !== principal ? <p className="c04-band-blue">Checking saved changes for this account. If this does not finish, return after checking access.</p> : issues.length === 0 ? <div className="c04-band-blue">No synchronization issues for the signed-in technician.</div> : issues.map((issue) => <div className="c04-band" key={issue.id} data-issue-kind={issue.kind}>
        <strong style={{ textTransform: "capitalize" }}>{issue.label}</strong>
        {issue.kind === "rejected_media" ? <>
          <p style={{ margin: "6px 0" }}>Not uploaded: this {issue.contentType?.startsWith("video/") ? "video" : "photograph"} is {formatMegabytes(issue.mediaBytes ?? 0)}, above the {formatMegabytes(maximumMediaBytes(issue.contentType ?? ""))} upload limit. It is kept on this device and will not be retried automatically.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!issue.contentType?.startsWith("video/") && <button className="btn btn-primary" disabled={busy === issue.id} onClick={() => reduceAndUpload(issue)}>{busy === issue.id ? "Reducing…" : "Reduce size and upload"}</button>}
            <button className="btn btn-secondary" onClick={() => saveCopy(issue)}>Save a copy to this device</button>
            {confirmRemove === issue.id
              ? <div className="c04-alert"><button className="btn c04-danger-fill" onClick={() => remove(issue)}>Confirm remove from this device</button>
                  <button className="btn btn-secondary" onClick={() => setConfirmRemove(null)}>Keep it</button></div>
              : <button className="btn btn-secondary" onClick={() => setConfirmRemove(issue.id)}>Remove from this device</button>}
          </div>
          {!issue.contentType?.startsWith("video/") && <p style={{ margin: "6px 0", color: "var(--text-secondary)" }}>Reducing replaces this local copy with a smaller JPEG that fits the limit. Save a copy first if you need the full-resolution original.</p>}
        </> : <>
          <p role="alert" style={{ margin: "6px 0" }}>{syncIssueMessage(issue.status, issue.error)}</p>
          {issue.error === "visit_finished" ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="btn btn-primary" disabled={busy === issue.id} onClick={() => keepFinishedVisitInspection(issue, "standalone")}>Save without a visit</button>
            <button className="btn btn-secondary" disabled={busy === issue.id} onClick={() => keepFinishedVisitInspection(issue, "new")}>Save in a new visit</button>
          </div> : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => retry(issue)}>{retryLabel(issue)}</button>
            {syncIssueCanDiscard(issue) && (confirmRemove === issue.id
              ? <div className="c04-alert"><p>Discarding removes this change from this device only. It does not change the server.</p>
                  <button className="btn c04-danger-fill" disabled={busy === issue.id} onClick={() => discard(issue)}>Confirm discard from this device</button>
                  <button className="btn btn-secondary" onClick={() => setConfirmRemove(null)}>Keep it</button></div>
              : <button className="btn btn-secondary" onClick={() => setConfirmRemove(issue.id)}>Discard this saved change</button>)}
          </div>}
        </>}
        {notes[issue.id] && <p className="error-text" role="status">{notes[issue.id]}</p>}
      </div>)}
    </div>
  </div>;
}
