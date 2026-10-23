import QRCode from "qrcode";
import type { Pool, PoolClient } from "pg";
import { openingsForOrgSubquery } from "../db/tenantScope";
import { openingQrUrl } from "./openingQr";

export const LABEL_TEMPLATE = "letter-2in-v1";
export async function openingLabel(client: Pool | PoolClient, id: string, organizationId: string) {
  const opening = (await client.query(`SELECT o.*, b.name AS building_name, p.name AS facility_name
    FROM openings o JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id
    WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})`, [id, organizationId])).rows[0];
  if (!opening) return null;
  const frame = (await client.query("SELECT condition FROM opening_frames WHERE opening_id=$1", [id])).rows;
  const leaves = (await client.query("SELECT leaf_role,condition FROM door_leaves WHERE opening_id=$1", [id])).rows;
  const hardware = (await client.query("SELECT condition,review_state FROM current_hardware_components WHERE opening_id=$1", [id])).rows;
  const assessed = (row: any) => ["good", "worn", "failed"].includes(row.condition);
  const requiredRoles = opening.opening_configuration === "pair" ? ["active", "inactive"] : ["single"];
  const missing = [
    ...(opening.completion_state !== "complete" ? ["opening_not_complete"] : []),
    ...(["retired", "decommissioned"].includes(opening.status) ? ["opening_retired"] : []),
    ...(!frame.length ? ["frame"] : []),
    ...requiredRoles.filter(role => !leaves.some(leaf => leaf.leaf_role === role)).map(role => `${role}_leaf`),
    ...(!hardware.length ? ["hardware_component"] : []),
    ...(frame.some(row => !assessed(row)) ? ["frame_condition"] : []),
    ...(leaves.some(row => !assessed(row)) ? ["leaf_condition"] : []),
    ...(hardware.some(row => !assessed(row)) ? ["hardware_condition"] : []),
    ...(hardware.some(row => row.review_state !== "reviewed") ? ["hardware_review"] : []),
  ];
  const metadata = { id, opening_code: opening.opening_code, facility_name: opening.facility_name,
    building_name: opening.building_name, completion_state: opening.completion_state,
    revision: Number(opening.revision), template_version: LABEL_TEMPLATE, eligible: missing.length === 0, missing };
  if (missing.length) return { ...metadata, payload: null, qr_data_url: null };
  const payload = openingQrUrl(opening.qr_token);
  return { ...metadata, payload, qr_data_url: await QRCode.toDataURL(payload, { width: 600, margin: 4 }) };
}
