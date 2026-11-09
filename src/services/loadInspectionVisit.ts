import { pool } from "../db/pool";
import { getObjectBytes } from "./storage";
import { NFPA80_ITEMS } from "./nfpa80Checklist";
import type { VisitDoor, VisitReportData } from "./inspectionVisits";

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

async function photoBytes(row: { inline_bytes?: Buffer | null; storage_url?: string | null }): Promise<Buffer | null> {
  if (row.inline_bytes && row.inline_bytes.length) return row.inline_bytes;
  const url = row.storage_url || "";
  if (!url.startsWith("private:")) return null;
  try {
    const bytes = await getObjectBytes(url.slice("private:".length), MAX_PHOTO_BYTES);
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

export async function loadInspectionVisit(visitId: string, organizationId: string): Promise<(VisitReportData & { propertyId: string; openingIds: string[]; inspectionIds: string[]; contactEmail: string | null; inspectorUserId: string; status: string; reportSent: boolean }) | null> {
  const visit = await pool.query(
    `SELECT v.property_id, v.inspector_user_id, v.status, v.report_sent_at, p.name AS facility_name, p.contact_email
     FROM inspection_visits v
     JOIN properties p ON p.id = v.property_id
     WHERE v.id = $1 AND v.organization_id = $2`,
    [visitId, organizationId],
  );
  if (!visit.rows[0]) return null;
  const inspections = await pool.query(
    `SELECT i.id, i.passed, i.notes, i.event_date, i.created_at, i.signed_by_name, i.inspector_qualification, i.inspector_license_number,
            i.signature_data, i.checklist_result, o.opening_code, o.location_description, o.id AS opening_id
     FROM inspection_events i
     JOIN openings o ON o.id = i.opening_id
     WHERE i.visit_id = $1 AND i.inspection_type = 'fire_door_nfpa80' AND i.checklist_result->>'status' = 'complete'`,
    [visitId],
  );
  const ids = inspections.rows.map((row) => row.id as string);
  const deficiencies = ids.length
    ? await pool.query(
      `SELECT d.inspection_event_id, d.item_key, d.note, ph.inline_bytes, ph.storage_url
       FROM fire_door_deficiencies d
       LEFT JOIN photos ph ON ph.id = d.photo_id
       WHERE d.inspection_event_id = ANY($1::uuid[])
       ORDER BY d.created_at`,
      [ids],
    )
    : { rows: [] };
  const byInspection = new Map<string, typeof deficiencies.rows>();
  for (const row of deficiencies.rows) {
    const list = byInspection.get(row.inspection_event_id) ?? [];
    list.push(row);
    byInspection.set(row.inspection_event_id, list);
  }
  const doors: VisitDoor[] = [];
  for (const row of inspections.rows) {
    const answers = (row.checklist_result?.items ?? {}) as Record<string, { result?: string; note?: string | null }>;
    const doorDeficiencies = [];
    for (const deficiency of byInspection.get(row.id) ?? []) {
      const spec = NFPA80_ITEMS.find((item) => item.key === deficiency.item_key);
      doorDeficiencies.push({
        section: spec?.section || deficiency.item_key,
        description: spec?.text || deficiency.item_key,
        note: deficiency.note as string,
        photo: await photoBytes(deficiency),
      });
    }
    doors.push({
      openingId: row.opening_id,
      openingCode: row.opening_code,
      location: row.location_description,
      passed: row.passed === true,
      notes: row.notes,
      inspectedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ? String(row.created_at) : null,
      deficiencies: doorDeficiencies,
      checklist: NFPA80_ITEMS.map((item) => ({
        section: item.section,
        result: (answers[item.key]?.result || "unanswered").toUpperCase(),
        note: answers[item.key]?.note ?? null,
      })),
    });
  }
  const first = inspections.rows[0];
  return {
    facilityName: visit.rows[0].facility_name,
    eventDate: first ? String(first.event_date).slice(0, 10) : "",
    inspectorName: first?.signed_by_name ?? null,
    qualification: first?.inspector_qualification ?? null,
    licenseNumber: first?.inspector_license_number ?? null,
    signatureData: inspections.rows.find((row) => typeof row.signature_data === "string" && row.signature_data.startsWith("data:image/"))?.signature_data ?? null,
    doors,
    propertyId: visit.rows[0].property_id,
    openingIds: inspections.rows.map((row) => row.opening_id as string),
    inspectionIds: ids,
    contactEmail: visit.rows[0].contact_email,
    inspectorUserId: visit.rows[0].inspector_user_id,
    status: visit.rows[0].status,
    reportSent: visit.rows[0].report_sent_at != null,
  };
}
