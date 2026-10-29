import { getDb, getOutbox, getPhotoOutbox } from "./db";
import type { SyncOperation } from "./offlineTypes";

// M4 (multi-company field app). All offline records (operations, pending photos, conflicts,
// cached openings) carry the user ID and company ID they were made under, and every reader and
// the upload pass use only the active company's records. Switching company therefore never mixes
// work between companies and NEVER deletes anything: work left in the other company stays on this
// device and resumes when the person switches back. Only the C2 wipe (session_revoked /
// account_deactivated) removes OI data, and it removes all of it.

export interface CompanyOption { organization_id: string; name: string | null; role: string; access?: string; is_home?: boolean }
export interface Principal { userId: string; organizationId: string }

export interface PendingWork {
  operations: number;
  photos: number;
  conflicts: number;
  inFlight: number;
  legacy: number;
  total: number;
}

const DONE: ReadonlySet<SyncOperation["state"]> = new Set(["verified"]);

export async function pendingWorkFor(principal: Principal): Promise<PendingWork> {
  const db = await getDb();
  const ops = (await db.getAll("operations")).filter((o) => o.actorUserId === principal.userId && o.organizationId === principal.organizationId);
  const open = ops.filter((o) => !DONE.has(o.state));
  const owned = new Set(ops.map((o) => o.operationId));
  const photos = (await db.getAll("media")).filter((m) => m.capturedByUserId === principal.userId && m.organizationId === principal.organizationId && m.uploadState !== "verified").length;
  const conflicts = (await db.getAll("conflicts")).filter((c) => c.resolutionState === "open" && owned.has(c.operationId)).length;
  // Pre-offline-protocol queues carry no company, so they always count as unsynced work.
  const legacy = (await getOutbox()).length + (await getPhotoOutbox()).length;
  const inFlight = open.filter((o) => o.state === "in_flight" || o.state === "verifying").length;
  return { operations: open.length, photos, conflicts, inFlight, legacy, total: open.length + photos + conflicts + legacy };
}

export type SwitchDecision =
  | { kind: "same" }
  | { kind: "allowed" }
  | { kind: "wait"; pending: PendingWork; message: string }
  | { kind: "confirm"; pending: PendingWork; message: string };

/** Pure decision: an upload in progress blocks the switch; other unsynced work needs explicit confirmation. */
export function decideSwitch(current: Principal, targetOrganizationId: string, pending: PendingWork, acknowledged = false): SwitchDecision {
  if (current.organizationId === targetOrganizationId) return { kind: "same" };
  if (pending.inFlight > 0) return { kind: "wait", pending, message: "An upload for this company is in progress. Wait for it to finish before switching company." };
  if (pending.total > 0 && !acknowledged) return { kind: "confirm", pending,
    message: `This company has ${pending.total} unsynced item(s) on this device. They are kept, not deleted, and will sync when you switch back to this company. Switch anyway?` };
  return { kind: "allowed" };
}

export const showCompanySwitcher = (companies: CompanyOption[]) => new Set(companies.map((c) => c.organization_id)).size > 1;
