import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  cacheOpening, closeFieldAppDb, enqueueOutboxItem, getCachedOpening, getDb, getOpenConflictsForPrincipal,
  getOfflineMediaForPrincipal, getSyncOperationsForPrincipal, loadAuth, putSyncOperation, saveAuth, updateCachedOpening, wipeAllOiData,
} from "../field-app/src/lib/db";
import { decideSwitch, pendingWorkFor, showCompanySwitcher } from "../field-app/src/lib/companySwitch";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { SyncOperation } from "../field-app/src/lib/offlineTypes";

vi.mock("../field-app/src/lib/sync", () => ({ flushOutbox: vi.fn(async () => undefined) }));
import { recordFreshSignIn } from "../field-app/src/lib/freshSignIn";

// M4: multi-company field app. Synthetic IDs only; fake IndexedDB; nothing leaves the process.
const U = "55555555-5555-4555-8555-555555555555";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pA = { userId: U, organizationId: A };
const pB = { userId: U, organizationId: B };
const fakeToken = (org: string) => "x." + Buffer.from(JSON.stringify({ userId: U, organizationId: org, role: "technician" })).toString("base64url") + ".sig";

function op(id: string, org: string, state: SyncOperation["state"] = "queued", extra: Partial<SyncOperation> = {}): SyncOperation {
  return { operationId: id, operationType: "create", entityType: "component", entityId: id, openingId: "op-" + org, organizationId: org, actorUserId: U,
    deviceId: "66666666-6666-4666-8666-666666666666", baseServerRevision: null, payload: { n: 1 }, payloadHash: "sha256:x", dependencyOperationIds: [],
    createdAtLocal: "2026-10-29T12:00:00.000Z", state, attemptCount: 0, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "m4", protocolVersion: SYNC_PROTOCOL_VERSION, ...extra } as SyncOperation;
}
async function seedTwoCompanies() {
  const db = await getDb();
  await putSyncOperation(op("10000000-0000-4000-8000-00000000000a", A));
  await putSyncOperation(op("10000000-0000-4000-8000-00000000000b", B, "conflict"));
  await db.put("media", { photoId: "p-a", openingId: "op-" + A, organizationId: A, capturedByUserId: U, uploadState: "queued", blob: new Blob(["a"]) } as any);
  await db.put("media", { photoId: "p-b", openingId: "op-" + B, organizationId: B, capturedByUserId: U, uploadState: "queued", blob: new Blob(["b"]) } as any);
  await db.put("conflicts", { conflictId: "c-b", operationId: "10000000-0000-4000-8000-00000000000b", openingId: "op-" + B, resolutionState: "open" } as any);
}

afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase("opening-intel-field"); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});

describe("company switch decision", () => {
  const none = { operations: 0, photos: 0, conflicts: 0, inFlight: 0, legacy: 0, total: 0 };
  it("allows a clean switch, blocks during an upload, and asks before leaving unsynced work", () => {
    expect(decideSwitch(pA, A, none).kind).toBe("same");
    expect(decideSwitch(pA, B, none).kind).toBe("allowed");
    const busy = { ...none, operations: 1, inFlight: 1, total: 1 };
    expect(decideSwitch(pA, B, busy).kind).toBe("wait");
    expect(decideSwitch(pA, B, busy, true).kind).toBe("wait");
    const left = { ...none, photos: 2, total: 2 };
    const d = decideSwitch(pA, B, left);
    expect(d.kind).toBe("confirm");
    expect((d as any).message).toMatch(/kept, not deleted/);
    expect(decideSwitch(pA, B, left, true).kind).toBe("allowed");
  });
  it("shows the switcher only with more than one company", () => {
    expect(showCompanySwitcher([{ organization_id: A, name: "A", role: "admin" }])).toBe(false);
    expect(showCompanySwitcher([{ organization_id: A, name: "A", role: "admin" }, { organization_id: A, name: "A", role: "admin" }])).toBe(false);
    expect(showCompanySwitcher([{ organization_id: A, name: "A", role: "admin" }, { organization_id: B, name: "B", role: "viewer" }])).toBe(true);
  });
});

describe("offline data is kept per company and person", () => {
  it("counts only the given company's unsynced work, plus company-less legacy queue items", async () => {
    await seedTwoCompanies();
    expect(await pendingWorkFor(pA)).toMatchObject({ operations: 1, photos: 1, conflicts: 0, inFlight: 0, legacy: 0, total: 2 });
    expect(await pendingWorkFor(pB)).toMatchObject({ operations: 1, photos: 1, conflicts: 1, total: 3 });
    await putSyncOperation(op("10000000-0000-4000-8000-00000000000c", A, "verified"));
    expect((await pendingWorkFor(pA)).operations).toBe(1);
    await putSyncOperation(op("10000000-0000-4000-8000-00000000000d", A, "in_flight"));
    expect((await pendingWorkFor(pA)).inFlight).toBe(1);
    await enqueueOutboxItem({ id: "legacy-1", kind: "service_event", payload: {} });
    expect((await pendingWorkFor(pB)).legacy).toBe(1);
    expect(await pendingWorkFor({ userId: "77777777-7777-4777-8777-777777777777", organizationId: A })).toMatchObject({ operations: 0, photos: 0, total: 1 });
  });

  it("switching never mixes or deletes another company's queue, photos or conflicts, and resumes only the target's stopped work", async () => {
    await seedTwoCompanies();
    await putSyncOperation(op("10000000-0000-4000-8000-0000000000a2", A, "auth_required", { principalChangeStop: true } as any));
    await putSyncOperation(op("10000000-0000-4000-8000-0000000000b2", B, "auth_required", { principalChangeStop: true } as any));
    await recordFreshSignIn({ token: fakeToken(A), ...pA, role: "technician" }, false, false);
    await cacheOpening({ id: "open-a", name: "A door" }, pA);
    expect((await getCachedOpening("open-a"))?.name).toBe("A door");
    // Switch to B (as AuthContext.switchCompany does after the server issues the B token).
    const resumed = await recordFreshSignIn({ token: fakeToken(B), ...pB, role: "technician" }, false, true);
    expect(resumed).toEqual(["10000000-0000-4000-8000-0000000000b2"]);
    expect((await loadAuth())?.organizationId).toBe(B);
    expect((await getSyncOperationsForPrincipal(U, B)).every((o) => o.organizationId === B)).toBe(true);
    expect((await getOfflineMediaForPrincipal(U, B)).map((m) => m.photoId)).toEqual(["p-b"]);
    expect((await getOpenConflictsForPrincipal(U, A))).toEqual([]);
    // A's cached opening is hidden and cannot be modified while B is active, but is not deleted.
    expect(await getCachedOpening("open-a")).toBeUndefined();
    await updateCachedOpening("open-a", (o) => ({ ...o, name: "overwritten" }));
    // A's work is untouched and still waiting.
    const aOps = await getSyncOperationsForPrincipal(U, A);
    expect(aOps.map((o) => o.state).sort()).toEqual(["auth_required", "queued"]);
    expect((await getOfflineMediaForPrincipal(U, A)).map((m) => m.photoId)).toEqual(["p-a"]);
    // Switch back to A: A's stopped work resumes, its cache is visible again and unchanged.
    expect(await recordFreshSignIn({ token: fakeToken(A), ...pA, role: "technician" }, false, true)).toEqual(["10000000-0000-4000-8000-0000000000a2"]);
    expect((await getCachedOpening("open-a"))?.name).toBe("A door");
    expect((await getOpenConflictsForPrincipal(U, B)).map((c) => c.conflictId)).toEqual(["c-b"]);
  });

  it("the C2 access-ended wipe still removes ALL OI data, for every company", async () => {
    await seedTwoCompanies();
    await saveAuth({ token: fakeToken(A), ...pA, role: "technician" });
    await enqueueOutboxItem({ id: "legacy-1", kind: "service_event", payload: {} });
    await wipeAllOiData();
    const db = await getDb();
    for (const name of Array.from(db.objectStoreNames)) expect(await db.count(name as any)).toBe(0);
    expect(await pendingWorkFor(pA)).toMatchObject({ total: 0 });
    expect(await pendingWorkFor(pB)).toMatchObject({ total: 0 });
  });
});

describe("source wiring", () => {
  const read = (p: string) => readFileSync("field-app/src/" + p, "utf8");
  it("the switcher is mounted, uses the server endpoints, and the switch path never wipes or clears", () => {
    expect(read("App.tsx")).toMatch(/<CompanySwitcher \/>/);
    const api = read("lib/api.ts");
    expect(api).toMatch(/"\/auth\/companies"/);
    expect(api).toMatch(/"\/auth\/switch-company"/);
    const ctx = read("lib/AuthContext.tsx");
    const fn = ctx.slice(ctx.indexOf("async function switchCompany"), ctx.indexOf("return (\n    <AuthContext.Provider"));
    expect(fn).toMatch(/decideSwitch\(/);
    expect(fn).toMatch(/pendingWorkFor\(/);
    expect(fn).not.toMatch(/wipeAllOiData|clearAuth|\.clear\(|\.delete\(/);
    expect(read("lib/companySwitch.ts")).not.toMatch(/\.clear\(|\.delete\(|wipeAllOiData/);
  });
  it("the field app never asks for tree scope, so child-location and provider limits stay server-enforced", () => {
    for (const p of ["lib/api.ts", "lib/sync.ts", "lib/facilitySync.ts", "lib/companySwitch.ts"]) expect(read(p)).not.toMatch(/X-OI-Scope|scope=tree/i);
  });
  it("opening detail lists only the active company's queued photos", () => {
    expect(read("pages/OpeningDetailPage.tsx")).toMatch(/item\.capturedByUserId === owner\.userId && item\.organizationId === owner\.organizationId/);
  });
});
