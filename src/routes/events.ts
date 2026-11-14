import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { facilityAccessPredicate, openingsForOrgSubquery } from "../db/tenantScope";
import { areaAllowsOpening } from "../db/areaAccess";
import { acquireClient } from "../db/acquireClient";
import { prepareFireDoorChecklist, applyFireDoorFollowUp } from "../services/nfpa80Inspection";
import { generalPassCarriesChecklist } from "../services/nfpa80Checklist";
import { generateNfpaInspectionPdf, generateNfpaVisitPdf } from "../services/nfpa80Report";
import { officialVisitPdf } from "../services/officialVisitPdf";
import { getObjectBytes } from "../services/storage";
import { bindInspectionVisit, visitCounts, visitDoorListItem, visitInspectionsShortfall, visitSummaryText } from "../services/inspectionVisits";
import { loadInspectionVisit } from "../services/loadInspectionVisit";
import { sendEmail, reportEmailBlockers, reportLinkBase } from "../services/email";
import { dashboardInspectionLink } from "../services/inspectionReportLink";
import { attachmentByteLimit } from "../services/purchasingSend";

export const eventsRouter = Router();
eventsRouter.use(requireAuth);
eventsRouter.use(enforceRolePermissions);
eventsRouter.use(auditLog);

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

const serviceEventSchema = z.object({
  opening_id: z.string().uuid(),
  hardware_component_id: z.string().uuid().optional(),
  performed_by_org_id: z.string().uuid().optional(),
  event_date: z.string(),
  work_performed: z.string().min(1),
  parts_used: z.array(z.string()).max(1000).optional(),
  cost: z.number().optional(),
});

eventsRouter.post("/service-events", async (req: AuthedRequest, res) => {
  const parsed = serviceEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    // A component-level service event must name a component of this same opening (the sync route
    // applies the same rule). Without it a foreign component id would be limited only by the FK.
    if (b.hardware_component_id) {
      const target = await pool.query("SELECT 1 FROM hardware_components WHERE id = $1 AND opening_id = $2", [b.hardware_component_id, b.opening_id]);
      if (!target.rows[0]) return res.status(409).json({ error: "component_not_in_opening" });
    }

    const result = await pool.query(
      `INSERT INTO service_events
        (opening_id, hardware_component_id, performed_by_org_id, performed_by_user_id, event_date, work_performed, parts_used, cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        // t97: the performing organization is the signed-in caller's, never a client claim.
        b.opening_id, b.hardware_component_id ?? null, orgId,
        userId, b.event_date, b.work_performed, b.parts_used ?? [], b.cost ?? null,
      ]
    );
    await pool.query(
      `UPDATE openings SET last_service_date = GREATEST(COALESCE(last_service_date, $1), $1) WHERE id = $2`,
      [b.event_date, b.opening_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const inspectionEventSchema = z.object({
  opening_id: z.string().uuid(),
  event_date: z.string(),
  inspection_type: z.enum(["general", "fire_door_nfpa80", "ada_compliance", "access_control"]),
  checklist_result: z.record(z.string(), z.any()).optional(),
  passed: z.boolean(),
  notes: z.string().optional(),
  signature_data: z.string().max(500_000).optional(), // a simple line-drawing PNG data URL is a few KB; 500KB is a generous sanity cap, not a real limit
  signed_by_name: z.string().optional(),
  inspector_qualification: z.string().max(200).optional(),
  inspector_license_number: z.string().max(80).optional(),
  visit_id: z.string().uuid().optional(),
  replace_open_visit: z.boolean().optional(),
});

eventsRouter.post("/inspection-events", async (req: AuthedRequest, res) => {
  const parsed = inspectionEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (generalPassCarriesChecklist(b.inspection_type, b.passed, b.checklist_result)) {
      return res.status(400).json({ error: "inspection_type_mismatch" });
    }
    if (b.inspection_type !== "fire_door_nfpa80") {
      const result = await pool.query(
        `INSERT INTO inspection_events
          (opening_id, performed_by_user_id, event_date, inspection_type, checklist_result, passed, notes,
           signature_data, signed_by_name, signed_at, inspector_qualification, inspector_license_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          b.opening_id, userId, b.event_date, b.inspection_type, b.checklist_result ?? {}, b.passed, b.notes ?? null,
          b.signature_data ?? null, b.signed_by_name ?? null, b.signature_data ? new Date().toISOString() : null, null, null,
        ]
      );
      return res.status(201).json(result.rows[0]);
    }

    const prepared = prepareFireDoorChecklist(b.checklist_result, b.signed_by_name, b.inspector_qualification, b.inspector_license_number, b.passed);
    if (!prepared.ok) return res.status(400).json({ error: prepared.error });
    const client = await acquireClient(res); if (!client) return;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO inspection_events
          (opening_id, performed_by_user_id, event_date, inspection_type, checklist_result, passed, notes,
           signature_data, signed_by_name, signed_at, inspector_qualification, inspector_license_number)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          b.opening_id, userId, b.event_date, b.inspection_type, JSON.stringify(prepared.stored), b.passed, b.notes ?? null,
          b.signature_data ?? null, b.signed_by_name ?? null, b.signature_data ? new Date().toISOString() : null,
          b.inspector_qualification?.trim() ?? null, b.inspector_license_number?.trim() ?? null,
        ]
      );
      const follow = await applyFireDoorFollowUp(client, {
        inspectionId: result.rows[0].id, openingId: b.opening_id, organizationId: orgId, userId, items: prepared.items,
      });
      if (follow.error) { await client.query("ROLLBACK"); return res.status(400).json({ error: follow.error }); }
      const visit = await bindInspectionVisit(client, { visitId: b.visit_id, inspectionId: result.rows[0].id, openingId: b.opening_id, organizationId: orgId, userId, replaceOpenVisit: b.replace_open_visit === true });
      if (visit.error) { await client.query("ROLLBACK"); return res.status(409).json({ error: visit.error }); }
      await client.query("COMMIT");
      const fresh = await pool.query("SELECT * FROM inspection_events WHERE id=$1", [result.rows[0].id]);
      return res.status(201).json({ ...fresh.rows[0], visit_id: visit.visitId ?? fresh.rows[0].visit_id });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

async function loadFireDoorReport(id: string, orgId: string) {
  const inspection = await pool.query(
    `SELECT i.*, o.opening_code, o.location_description
     FROM inspection_events i JOIN openings o ON o.id=i.opening_id
     WHERE i.id=$1 AND i.opening_id IN (${openingsForOrgSubquery(2)})`,
    [id, orgId],
  );
  if (!inspection.rows[0]) return null;
  const deficiencies = await pool.query(
    "SELECT item_key, note, status, repair_note, repaired_at FROM fire_door_deficiencies WHERE inspection_event_id=$1 ORDER BY created_at",
    [id],
  );
  return { inspection: inspection.rows[0], deficiencies: deficiencies.rows };
}

eventsRouter.get("/inspection-events/:id/report.pdf", async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_inspection" });
  try {
    const loaded = await loadFireDoorReport(req.params.id, req.auth!.organizationId);
    if (!loaded || loaded.inspection.inspection_type !== "fire_door_nfpa80" || loaded.inspection.checklist_result?.status !== "complete") {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await areaAllowsOpening(req.auth!.userId, loaded.inspection.opening_id))) return res.status(403).json({ error: "forbidden" });
    const pdf = await generateNfpaInspectionPdf({
      openingCode: loaded.inspection.opening_code,
      location: loaded.inspection.location_description,
      eventDate: String(loaded.inspection.event_date).slice(0, 10),
      inspectorName: loaded.inspection.signed_by_name,
      qualification: loaded.inspection.inspector_qualification,
      licenseNumber: loaded.inspection.inspector_license_number,
      passed: loaded.inspection.passed === true,
      notes: loaded.inspection.notes,
      signatureData: loaded.inspection.signature_data,
      checklist: loaded.inspection.checklist_result,
      deficiencies: loaded.deficiencies,
    });
    res.set("Content-Type", "application/pdf").send(pdf);
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

function reportRecipients(value: string | string[]): string[] {
  const list = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const email = item.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(item.trim());
  }
  return out;
}

eventsRouter.get("/inspection-events/:id/email-defaults", async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_inspection" });
  try {
    const row = await pool.query(
      `SELECT p.contact_email,
              COALESCE(NULLIF(btrim(signer.email), ''), sender.email) AS inspector_email,
              i.opening_id
       FROM inspection_events i
       JOIN openings o ON o.id = i.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN users sender ON sender.id = $3
       LEFT JOIN users signer ON signer.id = i.performed_by_user_id
       WHERE i.id = $1 AND i.inspection_type = 'fire_door_nfpa80' AND i.checklist_result->>'status' = 'complete'
         AND i.opening_id IN (${openingsForOrgSubquery(2)})`,
      [req.params.id, req.auth!.organizationId, req.auth!.userId],
    );
    if (!row.rowCount) return res.status(404).json({ error: "not_found" });
    if (!(await areaAllowsOpening(req.auth!.userId, row.rows[0].opening_id))) return res.status(403).json({ error: "forbidden" });
    const facility = row.rows[0].contact_email as string | null;
    const inspector = row.rows[0].inspector_email as string;
    res.set("Cache-Control", "no-store").json({
      facility_contact_email: facility,
      inspector_email: inspector,
      to: reportRecipients(facility ? [facility, inspector] : [inspector]),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.post("/inspection-events/:id/email", async (req: AuthedRequest, res) => {
  const body = z.object({
    to: z.union([z.string().trim().email().max(200), z.array(z.string().trim().email().max(200)).min(1).max(10)]),
  }).strict().safeParse(req.body);
  if (!body.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_email" });
  const recipients = reportRecipients(body.data.to);
  if (!recipients.length) return res.status(400).json({ error: "invalid_email" });
  try {
    const loaded = await loadFireDoorReport(req.params.id, req.auth!.organizationId);
    if (!loaded || loaded.inspection.checklist_result?.status !== "complete") return res.status(404).json({ error: "not_found" });
    if (!(await areaAllowsOpening(req.auth!.userId, loaded.inspection.opening_id))) return res.status(403).json({ error: "forbidden" });
    const pdf = await generateNfpaInspectionPdf({
      openingCode: loaded.inspection.opening_code,
      location: loaded.inspection.location_description,
      eventDate: String(loaded.inspection.event_date).slice(0, 10),
      inspectorName: loaded.inspection.signed_by_name,
      qualification: loaded.inspection.inspector_qualification,
      licenseNumber: loaded.inspection.inspector_license_number,
      passed: loaded.inspection.passed === true,
      notes: loaded.inspection.notes,
      signatureData: loaded.inspection.signature_data,
      checklist: loaded.inspection.checklist_result,
      deficiencies: loaded.deficiencies,
    });
    const limit = attachmentByteLimit();
    const attached = pdf.length <= limit;
    const dashboardLink = dashboardInspectionLink(reportLinkBase(), loaded.inspection.opening_id, req.params.id);
    const text = [
      attached ? "The inspection report is attached." : "The inspection report is ready.",
      dashboardLink
        ? `Sign in to review this inspection and save it to facility records: ${dashboardLink}`
        : "Sign in on the dashboard and open this opening to review the inspection and save it to facility records.",
    ].join("\n");
    const outcome = await sendEmail({
      to: recipients,
      subject: `Fire door inspection ${loaded.inspection.opening_code}`,
      text,
      html: `<p>${text.replace(/\n/g, "<br>")}</p>`,
      attachments: attached ? [{ filename: "fire-door-inspection.pdf", contentBase64: pdf.toString("base64") }] : undefined,
    });
    if (!outcome.sent) {
      const missing = outcome.reason === "email_not_configured" ? reportEmailBlockers() : undefined;
      if (missing) console.error("OI email", { outcome: "not_configured", missing });
      return res.status(503).json(missing ? { error: outcome.reason, missing } : { error: outcome.reason });
    }
    res.json({ sent: true, to: recipients, delivery_mode: attached ? "attachments" : "links" });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

async function visitForRequest(id: string, orgId: string, userId: string) {
  if (!z.string().uuid().safeParse(id).success) return { status: 400 as const, error: "invalid_visit" };
  const loaded = await loadInspectionVisit(id, orgId);
  if (!loaded || !loaded.doors.length) return { status: 404 as const, error: "not_found" };
  for (const openingId of loaded.openingIds) {
    if (!(await areaAllowsOpening(userId, openingId))) return { status: 403 as const, error: "forbidden" };
  }
  return { status: 200 as const, loaded };
}

eventsRouter.get("/inspection-visits/open", async (req: AuthedRequest, res) => {
  const propertyId = z.string().uuid().safeParse(typeof req.query.property_id === "string" ? req.query.property_id : "");
  if (!propertyId.success) return res.status(400).json({ error: "invalid_visit" });
  try {
    const allowed = await pool.query(
      `SELECT 1 FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id WHERE p.id = $1 AND ${facilityAccessPredicate(2)}`,
      [propertyId.data, req.auth!.organizationId],
    );
    if (!allowed.rows[0]) return res.status(404).json({ error: "not_found" });
    const open = await pool.query(
      `SELECT v.id,
        COALESCE((SELECT json_agg(json_build_object('inspectionId', i.id, 'openingId', i.opening_id, 'passed', i.passed) ORDER BY i.created_at)
          FROM inspection_events i WHERE i.visit_id = v.id), '[]'::json) AS inspections
       FROM inspection_visits v
       WHERE v.organization_id = $1 AND v.property_id = $2 AND v.inspector_user_id = $3 AND v.status = 'open'
       ORDER BY v.created_at DESC LIMIT 1`,
      [req.auth!.organizationId, propertyId.data, req.auth!.userId],
    );
    const row = open.rows[0];
    res.set("Cache-Control", "no-store").json({
      visit: row ? { id: row.id, inspections: Array.isArray(row.inspections) ? row.inspections : [] } : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.get("/inspection-visits/:id", async (req: AuthedRequest, res) => {
  try {
    const result = await visitForRequest(req.params.id, req.auth!.organizationId, req.auth!.userId);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    const counts = visitCounts(result.loaded.doors);
    res.set("Cache-Control", "no-store").json({
      id: req.params.id,
      facility_name: result.loaded.facilityName,
      event_date: result.loaded.eventDate,
      inspector_name: result.loaded.inspectorName,
      summary: visitSummaryText(result.loaded.doors),
      ...counts,
      inspection_ids: result.loaded.inspectionIds,
      status: result.loaded.status,
      report_sent: result.loaded.reportSent,
      doors: result.loaded.doors.map(visitDoorListItem),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.get("/inspection-visits/:id/report.pdf", async (req: AuthedRequest, res) => {
  try {
    const result = await visitForRequest(req.params.id, req.auth!.organizationId, req.auth!.userId);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    const stored = await pool.query(`SELECT report_storage_key FROM inspection_visits WHERE id=$1 AND organization_id=$2`, [req.params.id, req.auth!.organizationId]);
    const pdf = stored.rows[0]?.report_storage_key
      ? Buffer.from(await getObjectBytes(stored.rows[0].report_storage_key, 25 * 1024 * 1024))
      : await generateNfpaVisitPdf(result.loaded);
    res.set("Content-Type", "application/pdf").send(pdf);
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.get("/inspection-visits/:id/email-defaults", async (req: AuthedRequest, res) => {
  try {
    const result = await visitForRequest(req.params.id, req.auth!.organizationId, req.auth!.userId);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    const sender = await pool.query("SELECT email FROM users WHERE id=$1", [req.auth!.userId]);
    const inspector = (sender.rows[0]?.email as string | undefined) || "";
    const facility = result.loaded.contactEmail;
    res.set("Cache-Control", "no-store").json({
      facility_contact_email: facility,
      inspector_email: inspector,
      to: reportRecipients(facility ? [facility, inspector] : [inspector]),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.post("/inspection-visits/:id/official-pdf", async (req: AuthedRequest, res) => {
  const body = z.object({
    expected_inspection_ids: z.array(z.string().uuid()).max(200).optional(),
    expected_inspection_count: z.number().int().positive().max(200).optional(),
  }).strict().safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "invalid_report" });
  const started = Date.now();
  try {
    const result = await visitForRequest(req.params.id, req.auth!.organizationId, req.auth!.userId);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    const stored = await pool.query(`SELECT report_storage_key FROM inspection_visits WHERE id=$1 AND organization_id=$2`, [req.params.id, req.auth!.organizationId]);
    if (!stored.rows[0]?.report_storage_key) {
      const pending = visitInspectionsShortfall(result.loaded.inspectionIds, body.data.expected_inspection_ids, body.data.expected_inspection_count);
      if (pending > 0) return res.status(409).json({ error: "visit_inspections_pending", pending });
    }
    const official = await officialVisitPdf({
      visitId: req.params.id, organizationId: req.auth!.organizationId, propertyId: result.loaded.propertyId,
      userId: req.auth!.userId, report: result.loaded,
    });
    console.info(JSON.stringify({ event: "visit_official_pdf", ms: Date.now() - started, bytes: official.pdf.length, reused: official.reused, doors: result.loaded.doors.length }));
    res.json({ stored: true, reused: official.reused, bytes: official.pdf.length });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.post("/inspection-visits/:id/email", async (req: AuthedRequest, res) => {
  const body = z.object({
    to: z.union([z.string().trim().email().max(200), z.array(z.string().trim().email().max(200)).min(1).max(10)]),
    expected_inspection_ids: z.array(z.string().uuid()).max(200).optional(),
    expected_inspection_count: z.number().int().positive().max(200).optional(),
  }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_email" });
  const recipients = reportRecipients(body.data.to);
  if (!recipients.length) return res.status(400).json({ error: "invalid_email" });
  try {
    const result = await visitForRequest(req.params.id, req.auth!.organizationId, req.auth!.userId);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    const stored = await pool.query(`SELECT report_storage_key FROM inspection_visits WHERE id=$1 AND organization_id=$2`, [req.params.id, req.auth!.organizationId]);
    if (!stored.rows[0]?.report_storage_key) return res.status(409).json({ error: "report_not_stored" });
    const official = await officialVisitPdf({
      visitId: req.params.id, organizationId: req.auth!.organizationId, propertyId: result.loaded.propertyId,
      userId: req.auth!.userId, report: result.loaded,
    });
    const pdf = official.pdf;
    const limit = attachmentByteLimit();
    const attached = pdf.length <= limit;
    const text = attached
      ? `The combined fire door inspection for ${result.loaded.facilityName} is attached. ${visitSummaryText(result.loaded.doors)}`
      : `The combined fire door inspection for ${result.loaded.facilityName} is ready. ${visitSummaryText(result.loaded.doors)}`;
    const outcome = await sendEmail({
      to: recipients,
      subject: `Fire door inspection visit ${result.loaded.facilityName}`,
      text,
      html: `<p>${text}</p>`,
      attachments: attached ? [{ filename: "fire-door-inspection-visit.pdf", contentBase64: pdf.toString("base64") }] : undefined,
    });
    if (!outcome.sent) {
      const missing = outcome.reason === "email_not_configured" ? reportEmailBlockers() : undefined;
      return res.status(503).json(missing ? { error: outcome.reason, missing } : { error: outcome.reason });
    }
    await pool.query(
      `UPDATE inspection_visits
       SET status='finished', finished_at=COALESCE(finished_at, now()), report_sent_at=now(), report_recipients=$3
       WHERE id=$1 AND organization_id=$2`,
      [req.params.id, req.auth!.organizationId, recipients.join(", ")],
    );
    res.json({ sent: true, to: recipients, delivery_mode: attached ? "attachments" : "links" });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.post("/inspection-events/:id/facility-record", async (req: AuthedRequest, res) => {
  if (req.auth!.role !== "admin" && req.auth!.role !== "facilities_manager") return res.status(403).json({ error: "insufficient_role_for_action" });
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_inspection" });
  try {
    const loaded = await loadFireDoorReport(req.params.id, req.auth!.organizationId);
    if (!loaded || loaded.inspection.inspection_type !== "fire_door_nfpa80" || loaded.inspection.checklist_result?.status !== "complete") {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await areaAllowsOpening(req.auth!.userId, loaded.inspection.opening_id))) return res.status(403).json({ error: "forbidden" });
    const existing = await pool.query(
      `SELECT id, title, opening_id, document_type, inspection_event_id, created_at
       FROM documents WHERE inspection_event_id=$1`,
      [req.params.id],
    );
    if (existing.rowCount) return res.json({ document: existing.rows[0], already_saved: true });
    const pdf = await generateNfpaInspectionPdf({
      openingCode: loaded.inspection.opening_code,
      location: loaded.inspection.location_description,
      eventDate: String(loaded.inspection.event_date).slice(0, 10),
      inspectorName: loaded.inspection.signed_by_name,
      qualification: loaded.inspection.inspector_qualification,
      licenseNumber: loaded.inspection.inspector_license_number,
      passed: loaded.inspection.passed === true,
      notes: loaded.inspection.notes,
      signatureData: loaded.inspection.signature_data,
      checklist: loaded.inspection.checklist_result,
      deficiencies: loaded.deficiencies,
    });
    const title = `Fire door inspection ${loaded.inspection.opening_code} ${String(loaded.inspection.event_date).slice(0, 10)}`;
    const inserted = await pool.query(
      `INSERT INTO documents
        (opening_id, document_type, title, storage_url, file_size_bytes, uploaded_by_user_id, inspection_event_id, content, content_type)
       VALUES ($1,'inspection_report',$2,$3,$4,$5,$6,$7,'application/pdf')
       ON CONFLICT (inspection_event_id) DO NOTHING
       RETURNING id, title, opening_id, document_type, inspection_event_id, created_at`,
      [loaded.inspection.opening_id, title, `oi-record://inspection-report/${req.params.id}`, pdf.length, req.auth!.userId, req.params.id, pdf],
    );
    if (!inserted.rowCount) {
      const again = await pool.query(
        `SELECT id, title, opening_id, document_type, inspection_event_id, created_at FROM documents WHERE inspection_event_id=$1`,
        [req.params.id],
      );
      return res.json({ document: again.rows[0], already_saved: true });
    }
    res.status(201).json({ document: inserted.rows[0], already_saved: false });
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.post("/fire-door-deficiencies/:id/repair", async (req: AuthedRequest, res) => {
  const body = z.object({ repair_note: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
  if (!body.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_repair" });
  try {
    const existing = await pool.query(
      `SELECT opening_id FROM fire_door_deficiencies WHERE id=$1 AND status='open' AND opening_id IN (${openingsForOrgSubquery(2)})`,
      [req.params.id, req.auth!.organizationId],
    );
    if (!existing.rowCount) return res.status(404).json({ error: "not_found" });
    if (!(await areaAllowsOpening(req.auth!.userId, existing.rows[0].opening_id))) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      `UPDATE fire_door_deficiencies SET status='repaired', repair_note=$2, repaired_at=now(), repaired_by_user_id=$3
       WHERE id=$1 AND status='open' RETURNING *`,
      [req.params.id, body.data.repair_note, req.auth!.userId],
    );
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: "internal_error" }); }
});

eventsRouter.delete("/inspection-events/:id", async (req: AuthedRequest, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "owner_admin_required" });
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_inspection" });
  try {
    const row = await pool.query(
      `SELECT id, created_at FROM inspection_events WHERE id=$1 AND opening_id IN (${openingsForOrgSubquery(2)})`,
      [req.params.id, req.auth!.organizationId],
    );
    if (!row.rowCount) return res.status(404).json({ error: "not_found" });
    const age = await pool.query("SELECT $1::timestamptz > now() - interval '3 years' AS held", [row.rows[0].created_at]);
    if (age.rows[0].held) return res.status(409).json({ error: "retained_for_three_years" });
    await pool.query("DELETE FROM inspection_events WHERE id=$1", [req.params.id]);
    res.status(204).send();
  } catch (err: any) {
    if (err?.code === "23514") return res.status(409).json({ error: "retained_for_three_years" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
