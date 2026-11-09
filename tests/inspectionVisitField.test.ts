import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { closeFieldAppDb, getOfflineSetting, putOfflineSetting, saveAuth } from "../field-app/src/lib/db";
import { ensureOpenVisit, readVisitById, recordVisitInspection, visitSummaryText, withInspection } from "../field-app/src/lib/inspectionVisit";
import { selectedFacilityKey } from "../field-app/src/lib/facilitySync";

const userId = "55555555-5555-4555-8555-555555555555";
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const facilityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

it("reuses one visit for the same facility and does not duplicate a repeated save", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  await putOfflineSetting({ key: selectedFacilityKey({ userId, organizationId }), value: facilityId, updatedAt: new Date().toISOString() });
  const first = await ensureOpenVisit();
  const second = await ensureOpenVisit();
  expect(first?.id).toBe(second?.id);
  expect(first?.facilityId).toBe(facilityId);
  await recordVisitInspection(first!.id, { inspectionId: "insp-1", openingId: "door-1", passed: false });
  await recordVisitInspection(first!.id, { inspectionId: "insp-1", openingId: "door-1", passed: false });
  await recordVisitInspection(first!.id, { inspectionId: "insp-2", openingId: "door-2", passed: true });
  const stored = await readVisitById(first!.id);
  expect(stored?.inspections).toHaveLength(2);
  expect(stored?.facilityId).toBe(facilityId);
  expect(visitSummaryText(stored!.inspections)).toBe("This visit: 2 openings (1 passed, 1 failed)");
  const pointer = await getOfflineSetting(`inspection-visit-open:${userId}:${organizationId}:${facilityId}`);
  expect(pointer?.value).toBe(first!.id);
  expect(withInspection(stored!, { inspectionId: "insp-1", openingId: "door-1", passed: false }).inspections).toHaveLength(2);
});
