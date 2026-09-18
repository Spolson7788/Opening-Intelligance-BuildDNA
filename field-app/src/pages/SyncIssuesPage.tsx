import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getOutbox, getPhotoOutbox, retryOutboxItem } from "../lib/db";
import type { OutboxItem, PhotoOutboxItem } from "../lib/db";
import { flushOutbox } from "../lib/sync";

type Issue = { id: string; label: string; status: string; error?: string; photo: boolean; createdAt: number };

export function SyncIssuesPage() {
  const navigate = useNavigate();
  const [issues, setIssues] = useState<Issue[]>([]);

  async function load() {
    const [mutations, photos] = await Promise.all([getOutbox(), getPhotoOutbox()]);
    setIssues([
      ...mutations.filter((item: OutboxItem) => item.status !== "pending").map((item) => ({
        id: item.id, label: item.kind.replace(/_/g, " "), status: item.status,
        error: item.lastError, photo: false, createdAt: item.createdAt,
      })),
      ...photos.filter((item: PhotoOutboxItem) => item.status !== "pending").map((item) => ({
        id: item.id, label: `${item.relatedEntityType.replace(/_/g, " ")} photograph`, status: item.status,
        error: item.lastError, photo: true, createdAt: item.createdAt,
      })),
    ].sort((a, b) => a.createdAt - b.createdAt));
  }

  useEffect(() => { void load(); }, []);

  async function retry(issue: Issue) {
    await retryOutboxItem(issue.id, issue.photo);
    await flushOutbox();
    await load();
  }

  return <div className="app-shell">
    <div className="top-bar"><button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button></div>
    <div className="screen">
      <h2>Synchronization review</h2>
      <p style={{ color: "var(--text-secondary)" }}>Entries remain stored on this device until synchronization succeeds. Review conflicts before retrying.</p>
      {issues.length === 0 ? <div className="card">No synchronization issues.</div> : issues.map((issue) => <div className="card" key={`${issue.photo}-${issue.id}`}>
        <strong style={{ textTransform: "capitalize" }}>{issue.label}</strong>
        <p style={{ margin: "6px 0", color: "var(--text-secondary)" }}>Status: {issue.status}</p>
        {issue.error && <p className="error-text">{issue.error}</p>}
        <button className="btn btn-secondary" onClick={() => retry(issue)}>Retry after review</button>
      </div>)}
    </div>
  </div>;
}
