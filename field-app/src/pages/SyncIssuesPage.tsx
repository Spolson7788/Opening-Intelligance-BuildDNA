import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getOfflineMedia, getOfflineMediaForPrincipal, getOpenConflictsForPrincipal, getSyncOperationsForPrincipal, loadAuth, recoverOrphanedMediaOperation, removeRejectedMedia, replaceRejectedMediaWithReducedCopy, retrySyncOperationAfterReview } from "../lib/db";
import { checksumBlob, flushOutbox } from "../lib/sync";
import { syncIssuesForRecords } from "../lib/syncIssuesModel";
import type { SyncIssueView } from "../lib/syncIssuesModel";
import { formatMegabytes, maximumMediaBytes } from "../lib/mediaLimits";
import { prepareImageForUpload, reducedFilename } from "../lib/photoPreparation";

export function SyncIssuesPage() {
  const navigate = useNavigate();
  const [issues, setIssues] = useState<SyncIssueView[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const auth = await loadAuth();
    if (!auth) { setIssues([]); return; }
    const [operations, conflicts, media] = await Promise.all([
      getSyncOperationsForPrincipal(auth.userId, auth.organizationId),
      getOpenConflictsForPrincipal(auth.userId, auth.organizationId),
      getOfflineMediaForPrincipal(auth.userId, auth.organizationId),
    ]);
    setIssues(syncIssuesForRecords(operations, conflicts, media));
  }

  useEffect(() => { void load(); }, []);

  const note = (id: string, text: string) => setNotes((current) => ({ ...current, [id]: text }));

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

  async function remove(issue: SyncIssueView) {
    if (!issue.photoId) return;
    await removeRejectedMedia(issue.photoId);
    setConfirmRemove(null);
    await flushOutbox();
    await load();
  }

  return <div className="app-shell">
    <div className="top-bar"><button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button></div>
    <div className="screen">
      <h2>Synchronization review</h2>
      <p style={{ color: "var(--text-secondary)" }}>Entries remain stored on this device until synchronization succeeds. Review conflicts before retrying.</p>
      {issues.length === 0 ? <div className="card">No synchronization issues for the signed-in technician.</div> : issues.map((issue) => <div className="card" key={issue.id} data-issue-kind={issue.kind}>
        <strong style={{ textTransform: "capitalize" }}>{issue.label}</strong>
        {issue.kind === "rejected_media" ? <>
          <p style={{ margin: "6px 0" }}>Not uploaded: this {issue.contentType?.startsWith("video/") ? "video" : "photograph"} is {formatMegabytes(issue.mediaBytes ?? 0)}, above the {formatMegabytes(maximumMediaBytes(issue.contentType ?? ""))} upload limit. It is kept on this device and will not be retried automatically.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!issue.contentType?.startsWith("video/") && <button className="btn btn-primary" disabled={busy === issue.id} onClick={() => reduceAndUpload(issue)}>{busy === issue.id ? "Reducing…" : "Reduce size and upload"}</button>}
            <button className="btn btn-secondary" onClick={() => saveCopy(issue)}>Save a copy to this device</button>
            {confirmRemove === issue.id
              ? <><button className="btn btn-secondary" onClick={() => remove(issue)}>Confirm remove from this device</button>
                  <button className="btn btn-secondary" onClick={() => setConfirmRemove(null)}>Keep it</button></>
              : <button className="btn btn-secondary" onClick={() => setConfirmRemove(issue.id)}>Remove from this device</button>}
          </div>
          {!issue.contentType?.startsWith("video/") && <p style={{ margin: "6px 0", color: "var(--text-secondary)" }}>Reducing replaces this local copy with a smaller JPEG that fits the limit. Save a copy first if you need the full-resolution original.</p>}
        </> : <>
          <p style={{ margin: "6px 0", color: "var(--text-secondary)" }}>Status: {issue.status}</p>
          {issue.error && <p className="error-text">{issue.error}</p>}
          <button className="btn btn-secondary" onClick={() => retry(issue)}>{issue.conflict ? "Keep local change and retry"
            : issue.kind === "orphaned_media" ? "Restore upload operation"
              : ["in_flight", "verifying"].includes(issue.status) ? "Recover interrupted operation"
                : "Retry after authorization is restored"}</button>
        </>}
        {notes[issue.id] && <p className="error-text" role="status">{notes[issue.id]}</p>}
      </div>)}
    </div>
  </div>;
}
