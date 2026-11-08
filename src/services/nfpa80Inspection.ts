import { assessFireDoorChecklist, decodePhoto, type AssessedItem } from "./nfpa80Checklist";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export function prepareFireDoorChecklist(raw: unknown, inspectorName: string | undefined, qualification: string | undefined, licenseNumber: string | undefined, passed: boolean) {
  const assessed = assessFireDoorChecklist(raw, inspectorName, qualification, licenseNumber);
  if (!assessed.ok) return assessed;
  if (passed === assessed.anyFail) return { ok: false as const, error: "passed_does_not_match_checklist" };
  return assessed;
}

export async function applyFireDoorFollowUp(
  db: Queryable,
  args: { inspectionId: string; openingId: string; organizationId: string; userId: string; items: AssessedItem[] },
): Promise<{ error?: string }> {
  const stored: Record<string, { result: string; note: string | null; photo_id: string | null }> = {};
  for (const item of args.items) {
    let photoId = item.photoId;
    if (item.result === "fail" && item.photoBase64) {
      const bytes = decodePhoto(item.photoBase64);
      if (!bytes) return { error: "photo_unreadable" };
      const png = bytes[0] === 0x89;
      const photo = await db.query(
        `INSERT INTO photos (opening_id, related_entity_type, related_entity_id, storage_url, inline_bytes, content_type, byte_size, uploaded_by_user_id, organization_id)
         VALUES ($1, 'inspection_event', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [args.openingId, args.inspectionId, `inline://inspection/${args.inspectionId}/${item.key}`, bytes, png ? "image/png" : "image/jpeg", bytes.length, args.userId, args.organizationId],
      );
      photoId = photo.rows[0].id;
    }
    if (item.result === "fail" && photoId) {
      const owned = await db.query("SELECT 1 FROM photos WHERE id=$1 AND opening_id=$2", [photoId, args.openingId]);
      if (!owned.rows.length) return { error: "fail_requires_photo" };
    }
    stored[item.key] = { result: item.result, note: item.note, photo_id: photoId };
    if (item.result === "fail") {
      await db.query(
        `INSERT INTO fire_door_deficiencies
          (organization_id, opening_id, inspection_event_id, item_key, note, photo_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [args.organizationId, args.openingId, args.inspectionId, item.key, item.note, photoId],
      );
    }
  }
  await db.query("UPDATE inspection_events SET checklist_result=$2::jsonb WHERE id=$1", [
    args.inspectionId,
    JSON.stringify({ status: "complete", items: stored }),
  ]);
  const passedKeys = Object.entries(stored).filter(([, item]) => item.result === "pass").map(([key]) => key);
  if (passedKeys.length) {
    const prior = await db.query(
      `SELECT id, item_key, status FROM fire_door_deficiencies
       WHERE opening_id=$1 AND status IN ('open','repaired') AND item_key = ANY($2::text[])
         AND inspection_event_id <> $3`,
      [args.openingId, passedKeys, args.inspectionId],
    );
    if (prior.rows.length) {
      await db.query(
        `UPDATE fire_door_deficiencies
         SET status='reinspected', reinspection_event_id=$2
         WHERE id = ANY($1::uuid[])`,
        [prior.rows.map((row) => row.id), args.inspectionId],
      );
      for (const row of prior.rows) {
        await db.query(
          `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code)
           VALUES ($1,$2,'Cleared fire door deficiency on re-inspection','POST',$3,$4,201)`,
          [args.organizationId, args.userId, `/api/events/inspection-events/${args.inspectionId}`, JSON.stringify({
            deficiency_id: row.id, item_key: row.item_key, previous_status: row.status,
            reinspection_event_id: args.inspectionId, result: "pass",
          })],
        );
      }
    }
  }
  return {};
}
