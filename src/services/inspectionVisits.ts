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
  inspectedAt?: string | null;
  displayLabel?: string | null;
  repeatNote?: string | null;
  inspectionId?: string | null;
  openingType?: string | null;
  deficiencies: VisitDeficiency[];
  checklist: { section: string; result: string; note: string | null }[];
}

/** One inspected opening for the field visit list. Uses columns that already exist. */
export function visitDoorListItem(door: VisitDoor) {
  return {
    opening_id: door.openingId,
    inspection_id: door.inspectionId ?? null,
    opening_code: door.openingCode,
    opening_type: door.openingType ?? null,
    location: door.location,
    passed: door.passed,
    inspected_at: door.inspectedAt ?? null,
  };
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

function attemptSignature(door: VisitDoor): string {
  const checklist = door.checklist.map((item) => `${item.section}|${item.result}|${item.note ?? ""}`).join(";");
  const deficiencies = door.deficiencies.map((item) => `${item.section}|${item.note}|${item.photo ? "photo" : ""}`).join(";");
  return `${door.passed}|${door.notes ?? ""}|${checklist}|${deficiencies}`;
}

/** One row per door. The latest inspection time supplies the result, deficiencies, and photos. */
export function latestVisitDoors(doors: VisitDoor[]): VisitDoor[] {
  const groups = new Map<string, { door: VisitDoor; index: number }[]>();
  doors.forEach((door, index) => {
    const key = door.openingId || door.openingCode;
    const list = groups.get(key) ?? [];
    list.push({ door, index });
    groups.set(key, list);
  });
  const latest: VisitDoor[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => {
      const time = (a.door.inspectedAt || "").localeCompare(b.door.inspectedAt || "");
      if (time !== 0) return time;
      return a.index - b.index;
    });
    const winner = ordered[ordered.length - 1].door;
    if (ordered.length === 1) {
      latest.push(winner);
      continue;
    }
    const differs = ordered.slice(0, -1).some((item) => attemptSignature(item.door) !== attemptSignature(winner));
    latest.push({
      ...winner,
      repeatNote: differs ? `Inspected ${ordered.length} times in this visit; latest result shown.` : winner.repeatNote ?? null,
    });
  }
  return latest;
}

export function doorHeading(door: VisitDoor): string {
  return door.displayLabel || door.openingCode;
}

export function orderVisitDoors(doors: VisitDoor[]): VisitDoor[] {
  return [...doors].sort((a, b) => Number(a.passed) - Number(b.passed) || a.openingCode.localeCompare(b.openingCode));
}

export function openingCountText(count: number): string {
  return `${count} ${count === 1 ? "opening" : "openings"}`;
}

export function visitSummaryText(doors: VisitDoor[]): string {
  const counts = visitCounts(doors);
  return `This visit: ${openingCountText(counts.inspected)} (${counts.passed} passed, ${counts.failed} failed)`;
}

/** Failed doors, then every door. Passed doors do not appear in the failure section. */
export function visitReportOutline(data: VisitReportData): string[] {
  const doors = orderVisitDoors(latestVisitDoors(data.doors));
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
    lines.push(doorHeading(door));
    if (door.repeatNote) lines.push(door.repeatNote);
    if (door.location) lines.push(door.location);
    for (const deficiency of door.deficiencies) {
      lines.push(deficiency.section, deficiency.description, deficiency.note);
      lines.push(deficiency.photo ? "Photograph" : "Photograph stored with this inspection");
    }
    if (door.notes) lines.push(door.notes);
  }
  lines.push("Door details");
  for (const door of doors) {
    lines.push(doorHeading(door));
    if (door.repeatNote) lines.push(door.repeatNote);
    if (door.location) lines.push(door.location);
    lines.push(door.passed ? "Result: passed" : "Result: failed");
    for (const item of door.checklist) lines.push(`${item.section} ${item.result}`);
  }
  return lines;
}

type Queryable = { query: PoolClient["query"] };

const VISIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function newestOpenVisit(db: Queryable, organizationId: string, propertyId: string, userId: string): Promise<string | undefined> {
  const open = await db.query(
    `SELECT id FROM inspection_visits
     WHERE organization_id = $1 AND property_id = $2 AND inspector_user_id = $3 AND status = 'open'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [organizationId, propertyId, userId],
  );
  return open.rows[0]?.id as string | undefined;
}

/** One open visit per inspector per facility. A new id joins the open visit unless the phone explicitly replaced it. */
export async function bindInspectionVisit(
  db: Queryable,
  input: { visitId: string | null | undefined; inspectionId: string; openingId: string; organizationId: string; userId: string; replaceOpenVisit?: boolean },
): Promise<{ error?: string; visitId?: string }> {
  const place = await db.query(
    `SELECT p.id AS property_id FROM openings o
     JOIN buildings b ON b.id = o.building_id
     JOIN properties p ON p.id = b.property_id
     WHERE o.id = $1`,
    [input.openingId],
  );
  const propertyId = place.rows[0]?.property_id as string | undefined;
  if (!propertyId) return { error: "visit_facility_mismatch" };
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [`${input.organizationId}:${propertyId}:${input.userId}`]);
  let visitId = input.visitId || undefined;
  if (visitId && !VISIT_ID.test(visitId)) return { error: "invalid_visit" };
  const openId = await newestOpenVisit(db, input.organizationId, propertyId, input.userId);
  if (input.replaceOpenVisit) {
    if (!visitId) return { error: "invalid_visit" };
    await db.query(
      `UPDATE inspection_visits
       SET status = 'finished', finished_at = COALESCE(finished_at, now())
       WHERE organization_id = $1 AND property_id = $2 AND inspector_user_id = $3 AND status = 'open' AND id <> $4`,
      [input.organizationId, propertyId, input.userId, visitId],
    );
  } else if (!visitId) {
    visitId = openId;
    if (!visitId) return {};
  } else if (visitId !== openId) {
    const existing = await db.query("SELECT id, status FROM inspection_visits WHERE id = $1", [visitId]);
    if (!existing.rows[0] && openId) visitId = openId;
  }
  if (!visitId) return {};
  const existing = await db.query("SELECT organization_id, property_id, inspector_user_id, status FROM inspection_visits WHERE id = $1", [visitId]);
  if (!existing.rows[0]) {
    await db.query(
      `INSERT INTO inspection_visits (id, organization_id, property_id, inspector_user_id) VALUES ($1,$2,$3,$4)`,
      [visitId, input.organizationId, propertyId, input.userId],
    );
  } else if (existing.rows[0].organization_id !== input.organizationId || existing.rows[0].property_id !== propertyId) {
    return { error: "visit_facility_mismatch" };
  } else if (existing.rows[0].inspector_user_id !== input.userId) {
    return { error: "visit_inspector_mismatch" };
  } else if (existing.rows[0].status === "finished") {
    return { error: "visit_finished" };
  }
  await db.query("UPDATE inspection_events SET visit_id = $1 WHERE id = $2", [visitId, input.inspectionId]);
  return { visitId };
}
