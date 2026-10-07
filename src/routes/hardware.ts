import { Router } from "express";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";
import {identityInputError,identityValues} from '../services/hardwareIdentity';

export const hardwareRouter = Router();
hardwareRouter.use(requireAuth);
hardwareRouter.use(enforceRolePermissions);
hardwareRouter.use(auditLog);

// Every hardware part's permanent tracker ID — generated server-side, exactly
// like openings.qr_token, and never accepted from the client. "TRK-" plus 8
// hex characters gives 4 billion+ combinations; collisions are astronomically
// unlikely at this scale, so (like qr_token) there's no retry-on-conflict loop.
function generateTrackerId(): string {
  return `TRK-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

// A hardware component is only reachable through an opening the caller's org owns,
// so every route here either takes opening_id directly or joins through it.
async function assertHardwareInOrg(hardwareId: string, orgId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT hc.opening_id FROM hardware_components hc
     WHERE hc.id = $1 AND hc.opening_id IN (${openingsForOrgSubquery(2)})`,
    [hardwareId, orgId]
  );
  return result.rows[0]?.opening_id ?? null;
}

const createHardwareSchema = z.object({
  id: z.string().uuid().optional(),
  opening_id: z.string().uuid(),
  component_type: z.enum([
    "lockset", "cylinder", "closer", "exit_device", "hinge",
    "automatic_operator", "panic_bar", "access_control_reader",
    "keypad", "electric_strike", "power_transfer", "maglock",
    "request_to_exit_device", "other",
  ]),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
  finish: z.string().optional(),
  install_date: z.string().optional(),
  warranty_expiration: z.string().optional(),
  notes: z.string().optional(),
  unit_cost: z.number().min(0).optional(),
  supplier_name: z.string().optional(),
  supplier_contact: z.string().optional(),
  serial_number: z.string().optional(),
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
  shipment_status: z.enum(["not_shipped", "ordered", "shipped", "in_transit", "delivered", "installed", "other"]).optional(),
  expected_delivery_date: z.string().optional(),
  shipped_date: z.string().optional(),
  delivered_date: z.string().optional(),
  mounting_scope: z.enum(["opening", "frame", "door_leaf"]).optional(),
  door_leaf_id: z.string().uuid().optional(),
  frame_id: z.string().uuid().optional(),
  position_label: z.string().optional(),
  client_operation_id: z.string().uuid().optional(),
  condition: z.enum(["good", "worn", "failed", "unverified"]).optional(),
  identity_status: z.enum(["established", "unresolved"]).optional(),
  review_state: z.enum(["pending", "reviewed"]).optional(),
  replacement_required: z.boolean().optional(),
  identity_source: z.enum(['unknown','technician_identified','photo_suggestion']).optional(),
  identity_acknowledged: z.boolean().optional(),
  recognition_run_id: z.string().uuid().optional(),
});

// Shared approved catalog choices. Selection is a technician assertion, not AI evidence.
hardwareRouter.get('/catalog',async(req,res)=>{
 const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,200):'';
 try{const result=await pool.query(`SELECT DISTINCT d.brand AS manufacturer,m.model AS model_number,m.series
  FROM reference_document_models m JOIN reference_documents d ON d.sha256=m.doc_sha256
  JOIN reference_pages p ON p.doc_sha256=m.doc_sha256 AND p.page_no=m.evidence_page
  WHERE d.status='approved' AND p.citable AND NOT p.fraction_unverified
   AND ($1='' OR d.brand ILIKE $2 OR m.model ILIKE $2)
  ORDER BY manufacturer,model_number LIMIT 200`,[q,'%'+q+'%']);
  res.setHeader('Cache-Control','no-store');return res.json({products:result.rows});
 }catch{return res.status(503).json({error:'product_catalog_unavailable'});}
});

async function validateMountingTarget(
  openingId: string,
  mountingScope: "opening" | "frame" | "door_leaf",
  doorLeafId?: string,
  frameId?: string
): Promise<string | null> {
  if (mountingScope === "door_leaf") {
    if (!doorLeafId || frameId) return "door_leaf_target_required";
    const leaf = await pool.query("SELECT 1 FROM door_leaves WHERE id=$1 AND opening_id=$2", [doorLeafId, openingId]);
    if (!leaf.rows.length) return "door_leaf_not_in_opening";
  } else if (mountingScope === "frame") {
    if (!frameId || doorLeafId) return "frame_target_required";
    const frame = await pool.query("SELECT 1 FROM opening_frames WHERE id=$1 AND opening_id=$2", [frameId, openingId]);
    if (!frame.rows.length) return "frame_not_in_opening";
  } else if (doorLeafId || frameId) {
    return "opening_scope_cannot_have_leaf_or_frame";
  }
  return null;
}

hardwareRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const mountingScope = b.mounting_scope ?? "opening";
    const identityError=identityInputError(b);
    if(identityError)return res.status(400).json({error:identityError});
    let identityRun:any;
    if(b.recognition_run_id){
      const run=await pool.query('SELECT * FROM recognition_runs WHERE id=$1 AND opening_id=$2 AND user_id=$3 AND organization_id=$4',[b.recognition_run_id,b.opening_id,req.auth!.userId,orgId]);
      if(!run.rows.length)return res.status(400).json({error:'invalid_recognition_run'});
      identityRun=run.rows[0];
    }
    const provenance=identityValues(b,req.auth!.userId,identityRun);
    const targetError = await validateMountingTarget(b.opening_id, mountingScope, b.door_leaf_id, b.frame_id);
    if (targetError) return res.status(400).json({ error: targetError });
    const trackerId = generateTrackerId();
    const result = await pool.query(
      `INSERT INTO hardware_components
        (id, opening_id, component_type, manufacturer, model_number, finish, install_date, warranty_expiration, notes,
         unit_cost, supplier_name, supplier_contact, tracker_id, serial_number, carrier, tracking_number,
         shipment_status, expected_delivery_date, shipped_date, delivered_date,
         mounting_scope, door_leaf_id, frame_id, position_label, client_operation_id,
         condition, identity_status, review_state, replacement_required,
         identity_source,identity_acknowledged_by,identity_acknowledged_at,identity_recognition_run_id,identity_value_producer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
       ON CONFLICT (opening_id, client_operation_id) WHERE client_operation_id IS NOT NULL
       DO UPDATE SET opening_id=EXCLUDED.opening_id RETURNING *`,
      [
        b.id ?? randomUUID(), b.opening_id, b.component_type, b.manufacturer ?? null, b.model_number ?? null,
        b.finish ?? null, b.install_date ?? null, b.warranty_expiration ?? null, b.notes ?? null,
        b.unit_cost ?? null, b.supplier_name ?? null, b.supplier_contact ?? null,
        trackerId, b.serial_number ?? null, b.carrier ?? null, b.tracking_number ?? null,
        b.shipment_status ?? "not_shipped", b.expected_delivery_date ?? null,
        b.shipped_date ?? null, b.delivered_date ?? null,
        mountingScope, b.door_leaf_id ?? null, b.frame_id ?? null,
        b.position_label ?? null, b.client_operation_id ?? null,
        b.condition ?? "unverified", b.identity_status ?? "unresolved",
        b.review_state ?? "pending", b.replacement_required ?? false,
        provenance.identity_source,provenance.identity_acknowledged_by,provenance.identity_acknowledged_at,provenance.identity_recognition_run_id,provenance.identity_value_producer,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// List all hardware for a given opening
hardwareRouter.get("/by-opening/:openingId", async (req: AuthedRequest, res) => {
  const { openingId } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    if (!(await assertOpeningInOrg(openingId, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const result = await pool.query(
      "SELECT * FROM hardware_components WHERE opening_id = $1 ORDER BY install_date",
      [openingId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Portfolio-wide hardware search — this is what makes "find every Cal-Royal cylinder
// installed before 2019" a real query instead of a hypothetical in the pitch deck.
hardwareRouter.get("/", async (req: AuthedRequest, res) => {
  const { manufacturer, model_number, component_type, installed_before, installed_after } = req.query;
  const orgId = req.auth!.organizationId;
  const conditions: string[] = [];
  const values: any[] = [];

  if (manufacturer) {
    values.push(`%${manufacturer}%`);
    conditions.push(`manufacturer ILIKE $${values.length}`);
  }
  if (model_number) {
    values.push(`%${model_number}%`);
    conditions.push(`model_number ILIKE $${values.length}`);
  }
  if (component_type) {
    values.push(component_type);
    conditions.push(`component_type = $${values.length}`);
  }
  if (installed_before) {
    values.push(installed_before);
    conditions.push(`install_date <= $${values.length}`);
  }
  if (installed_after) {
    values.push(installed_after);
    conditions.push(`install_date >= $${values.length}`);
  }
  values.push(orgId);
  conditions.push(`opening_id IN (${openingsForOrgSubquery(values.length)})`);

  try {
    const result = await pool.query(
      `SELECT * FROM hardware_components WHERE ${conditions.join(" AND ")} ORDER BY install_date LIMIT 1000`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const updateHardwareSchema = createHardwareSchema.partial().omit({ id: true, opening_id: true });

hardwareRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  const parsed = updateHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const client=await pool.connect();let committed=false;
  try {
    await client.query("BEGIN");
    const currentIdentity=(await client.query(`SELECT * FROM hardware_components WHERE id=$1 AND opening_id IN (${openingsForOrgSubquery(2)}) FOR UPDATE`,[id,orgId])).rows[0];
    if(!currentIdentity)return res.status(404).json({error:"not_found"});
    const openingId=currentIdentity.opening_id;

    if (parsed.data.mounting_scope !== undefined || parsed.data.door_leaf_id !== undefined || parsed.data.frame_id !== undefined) {
      const current = await client.query(
        "SELECT mounting_scope, door_leaf_id, frame_id FROM hardware_components WHERE id=$1",
        [id]
      );
      const merged = { ...current.rows[0], ...parsed.data };
      const targetError = await validateMountingTarget(
        openingId,
        merged.mounting_scope,
        merged.door_leaf_id ?? undefined,
        merged.frame_id ?? undefined
      );
      if (targetError) return res.status(400).json({ error: targetError });
    }

    const {identity_acknowledged,recognition_run_id,...updates}=parsed.data;
    const identityChanged=['manufacturer','model_number','component_type','identity_status'].some(k=>k in updates&&(updates as any)[k]!==currentIdentity[k]);
    const sourceChanged=updates.identity_source!==undefined&&updates.identity_source!==currentIdentity.identity_source;
    const valuesToSave:Record<string,unknown>={...updates};
    const retainsAcknowledgement=!identityChanged&&!sourceChanged&&identity_acknowledged!==false&&
      ['technician_identified','photo_suggestion'].includes(currentIdentity.identity_source)&&
      currentIdentity.identity_acknowledged_by&&currentIdentity.identity_acknowledged_at;
    if(updates.identity_status==='established'&&identity_acknowledged!==true&&!retainsAcknowledgement)
      return res.status(400).json({error:'identity_acknowledgment_required'});
    if(identity_acknowledged===true){
      const merged={...currentIdentity,...updates,identity_acknowledged:true,recognition_run_id:recognition_run_id||(updates.identity_source==='technician_identified'?undefined:currentIdentity.identity_recognition_run_id)||undefined};
      const error=identityInputError(merged);if(error)return res.status(400).json({error});
      let identityRun:any;
      if(merged.recognition_run_id){const run=await client.query('SELECT * FROM recognition_runs WHERE id=$1 AND opening_id=$2 AND user_id=$3 AND organization_id=$4',[merged.recognition_run_id,openingId,req.auth!.userId,orgId]);if(!run.rows.length)return res.status(400).json({error:'invalid_recognition_run'});identityRun=run.rows[0];}
      Object.assign(valuesToSave,identityValues(merged,req.auth!.userId,identityRun));
    }else if(identityChanged||sourceChanged||identity_acknowledged===false){
      if(updates.identity_source==='technician_identified'||updates.identity_source==='photo_suggestion')return res.status(400).json({error:'identity_acknowledgment_required'});
      Object.assign(valuesToSave,{identity_source:'unknown',identity_value_producer:'unknown',identity_acknowledged_by:null,identity_acknowledged_at:null,identity_recognition_run_id:null,identity_status:'unresolved',review_state:'pending'});
    }
    const fields = Object.entries(valuesToSave).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return res.status(400).json({ error: "no_fields_to_update" });

    const setClause = fields.map(([k], i) => `${k} = $${i + 1}`).join(", ");
    const values = fields.map(([, v]) => v);
    values.push(id);

    const result = await client.query(
      `UPDATE hardware_components SET ${setClause} WHERE id = $${values.length} RETURNING *`,
      values
    );
    await client.query("COMMIT");committed=true;
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }finally{if(!committed)await client.query("ROLLBACK");client.release();}
});

hardwareRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const openingId = await assertHardwareInOrg(id, orgId);
    if (!openingId) return res.status(404).json({ error: "not_found" });

    await pool.query("DELETE FROM hardware_components WHERE id = $1", [id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const bulkImportHardwareRowSchema = z.object({
  opening_code: z.string().min(1),
  component_type: z.enum([
    "lockset", "cylinder", "closer", "exit_device", "hinge",
    "automatic_operator", "panic_bar", "access_control_reader",
    "keypad", "electric_strike", "power_transfer", "maglock",
    "request_to_exit_device", "other",
  ]),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
  finish: z.string().optional(),
  install_date: z.string().optional(),
  warranty_expiration: z.string().optional(),
  notes: z.string().optional(),
  unit_cost: z.number().min(0).optional(),
  supplier_name: z.string().optional(),
  supplier_contact: z.string().optional(),
  serial_number: z.string().optional(),
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
  shipment_status: z.enum(["not_shipped", "ordered", "shipped", "in_transit", "delivered", "installed", "other"]).optional(),
  expected_delivery_date: z.string().optional(),
  shipped_date: z.string().optional(),
  delivered_date: z.string().optional(),
});

const bulkImportHardwareSchema = z.object({
  rows: z.array(bulkImportHardwareRowSchema).min(1).max(1000),
});

// Bulk-attach hardware to existing openings from a CSV — deliberately a
// separate import from bulk-creating openings themselves. A real door
// commonly carries 5+ distinct parts (lockset, 3 hinges, closer, keypad,
// electric strike...), so "one row = one opening + one part" would mean
// repeating every opening's details across N rows per door. Instead, each
// row here references the opening by its human-readable opening_code —
// which is globally unique — so this doesn't even need a building_id: one
// CSV can attach parts to openings spanning any building or property the
// caller's org owns. Same per-row success/failure pattern as the openings
// bulk import, for the same reason (a few bad rows shouldn't sink the batch).
hardwareRouter.post("/bulk-import", async (req: AuthedRequest, res) => {
  const parsed = bulkImportHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { rows } = parsed.data;
  const orgId = req.auth!.organizationId;

  const results: Array<{
    row: number;
    opening_code: string;
    component_type: string;
    status: "created" | "error";
    id?: string;
    error?: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const openingResult = await pool.query(
        `SELECT id FROM openings WHERE opening_code = $1 AND id IN (${openingsForOrgSubquery(2)})`,
        [row.opening_code, orgId]
      );
      if (openingResult.rows.length === 0) {
        results.push({ row: i, opening_code: row.opening_code, component_type: row.component_type, status: "error", error: "opening_code not found" });
        continue;
      }
      const openingId = openingResult.rows[0].id;

      const trackerId = generateTrackerId();
      const insertResult = await pool.query(
        `INSERT INTO hardware_components
          (opening_id, component_type, manufacturer, model_number, finish, install_date, warranty_expiration, notes,
           unit_cost, supplier_name, supplier_contact, tracker_id, serial_number, carrier, tracking_number,
           shipment_status, expected_delivery_date, shipped_date, delivered_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [
          openingId, row.component_type, row.manufacturer ?? null, row.model_number ?? null,
          row.finish ?? null, row.install_date ?? null, row.warranty_expiration ?? null, row.notes ?? null,
          row.unit_cost ?? null, row.supplier_name ?? null, row.supplier_contact ?? null,
          trackerId, row.serial_number ?? null, row.carrier ?? null, row.tracking_number ?? null,
          row.shipment_status ?? "not_shipped", row.expected_delivery_date ?? null,
          row.shipped_date ?? null, row.delivered_date ?? null,
        ]
      );
      results.push({ row: i, opening_code: row.opening_code, component_type: row.component_type, status: "created", id: insertResult.rows[0].id });
    } catch (err) {
      console.error(err);
      results.push({ row: i, opening_code: row.opening_code, component_type: row.component_type, status: "error", error: "insert_failed" });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  res.status(207).json({
    total: rows.length,
    created,
    failed: rows.length - created,
    results,
  });
});
