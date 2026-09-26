import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getOfflineMediaForPrincipal, getOpenConflictsForPrincipal, getSyncOperationsForPrincipal, loadAuth, recoverOrphanedMediaOperation, retrySyncOperationAfterReview } from "../lib/db";
import { flushOutbox } from "../lib/sync";
import { syncIssuesForRecords } from "../lib/syncIssuesModel";
import type { SyncIssueView } from "../lib/syncIssuesModel";

export function SyncIssuesPage() {
  const navigate = useNavigate();
  const [issues, setIssues] = useState<SyncIssueView[]>([]);

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

  async function retry(issue: SyncIssueView) {
    if (issue.kind === "orphaned_media") await recoverOrphanedMediaOperation(issue.id);
    else await retrySyncOperationAfterReview(issue.id, issue.conflict);
    await flushOutbox();
    await load();
  }

  return <div className="app-shell">
    <div className="top-bar"><button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button></div>
    <div className="screen">
      <h2>Synchronization review</h2>
      <p style={{ color: "var(--text-secondary)" }}>Entries remain stored on this device until synchronization succeeds. Review conflicts before retrying.</p>
      {issues.length === 0 ? <div className="card">No synchronization issues for the signed-in technician.</div> : issues.map((issue) => <div className="card" key={issue.id}>
        <strong style={{ textTransform: "capitalize" }}>{issue.label}</strong>
        <p style={{ margin: "6px 0", color: "var(--text-secondary)" }}>Status: {issue.status}</p>
        {issue.error && <p className="error-text">{issue.error}</p>}
        <button className="btn btn-secondary" onClick={() => retry(issue)}>{issue.conflict ? "Keep local change and retry"
          : issue.kind === "orphaned_media" ? "Restore upload operation"
            : ["in_flight", "verifying"].includes(issue.status) ? "Recover interrupted operation"
              : "Retry after authorization is restored"}</button>
      </div>)}
    </div>
  </div>;
}
