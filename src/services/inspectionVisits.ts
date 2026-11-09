import type { PoolClient } from "pg";
import { NFPA80_ITEMS } from "./nfpa80Checklist";

export interface VisitDeficiency {
  section: string;
  description: string;
  note: string;
  photo: Buffer | null;
}

export interface VisitDoor {
  openingId: string;
  openingCode: string;
  location: string | null;
  passed: boolean;
  notes: string | null;
  deficiencies: VisitDeficiency[];
  checklist: { section: string; result: string; note: string | null }[];
}

export interface VisitReportData {
  facilityName: string;
  eventDate: string;
  inspectorName: string | null;
  qualification: string | null;
  licenseNumber: string | null;
  signatureData?: string | null;
  doors: VisitDoor[];
}

export function visitInspectionsShortfall(serverIds: string[], expectedIds?: string[], expectedCount?: number): number {
  if (!expectedIds && expectedCount == null) return 0;
  const server = new Set(serverIds);
  const uniqueExpected = expectedIds ? [...new Set(expectedIds)] : [];
  const missingIds = uniqueExpected.filter((id) => !server.has(id)).length;
  const count = uniqueExpected.length || expectedCount || 0;
  return Math.max(missingIds, Math.max(0, count - serverIds.length));
}

export function visitCounts(doors: VisitDoor[]) {
  const failed = doors.filter((door) => !door.passed).length;
  return { inspected: doors.length, passed: doors.length - failed, failed };
}

export function orderVisitDoors(doors: VisitDoor[]): VisitDoor[] {
  return [...doors].sort((a, b) => Number(a.passed) - Number(b.passed) || a.openingCode.localeCompare(b.openingCode));
}

export function visitSummaryText(doors: VisitDoor[]): string {
  const counts = visitCounts(doors);
  return `This visit: ${counts.inspected} openings (${counts.passed} passed, ${counts.failed} failed)`;
}

/** Failed doors, then every door. Passed doors do not appear in the failure section. */
export function visitReportOutline(data: VisitReportData): string[] {
  const doors = orderVisitDoors(data.doors);
  const counts = visitCounts(doors);
  const lines = [
    data.facilityName,
    data.eventDate,
    data.inspectorName || "Not named",
    `Inspected ${counts.inspected}`,
    `Passed ${counts.passed}`,
    `Failed ${counts.failed}`,
    "Failed doors",
  ];
  for (const door of doors.filter((item) => !item.passed)) {
    lines.push(door.openingCode);
    for (const deficiency of door.deficiencies) {
      lines.push(deficiency.section, deficiency.description, deficiency.note);
      lines.push(deficiency.photo ? "Photograph" : "Photograph stored with this inspection");
    }
    if (door.notes) lines.push(door.notes);
  }
  lines.push("Door details");
  for (const door of doors) {
    lines.push(door.openingCode, door.passed ? "Result: passed" : "Result: failed");
    for (const item of door.checklist) lines.push(`${item.section} ${item.result}`);
  }
  return lines;
}

type Queryable = { query: PoolClient["query"] };

export async function bindInspectionVisit(
  db: Queryable,
  input: { visitId: string | null | undefined; inspectionId: string; openingId: string; organizationId: string; userId: string },
): Promise<{ error?: string }> {
  if (!input.visitId) return {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.visitId)) {
    return { error: "invalid_visit" };
  }
  const place = await db.query(
    `SELECT p.id AS property_id FROM openings o
     JOIN buildings b ON b.id = o.building_id
     JOIN properties p ON p.id = b.property_id
     WHERE o.id = $1`,
    [input.openingId],
  );
  const propertyId = place.rows[0]?.property_id as string | undefined;
  if (!propertyId) return { error: "visit_facility_mismatch" };
  const existing = await db.query("SELECT organization_id, property_id, inspector_user_id FROM inspection_visits WHERE id = $1", [input.visitId]);
  if (!existing.rows[0]) {
    await db.query(
      `INSERT INTO inspection_visits (id, organization_id, property_id, inspector_user_id) VALUES ($1,$2,$3,$4)`,
      [input.visitId, input.organizationId, propertyId, input.userId],
    );
  } else if (existing.rows[0].organization_id !== input.organizationId || existing.rows[0].property_id !== propertyId) {
    return { error: "visit_facility_mismatch" };
  } else if (existing.rows[0].inspector_user_id !== input.userId) {
    return { error: "visit_inspector_mismatch" };
  }
  await db.query("UPDATE inspection_events SET visit_id = $1 WHERE id = $2", [input.visitId, input.inspectionId]);
  return {};
}
