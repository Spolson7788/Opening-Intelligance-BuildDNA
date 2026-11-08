// Swinging fire door annual inspection items for NFPA 80 (2025), section 5.2.4.2.
// Wording is ours. The standard's sentences are not copied here.
// Parenthetical numbers follow the published 13-point order for that section.

export const NFPA80_EDITION = "2025";

export interface Nfpa80Item {
  key: string;
  section: string;
  text: string;
}

export const NFPA80_ITEMS: Nfpa80Item[] = [
  { key: "labels", section: "5.2.4.2(1)", text: "The labels on the fire door and frame are in place and can be read." },
  { key: "holes_breaks", section: "5.2.4.2(2)", text: "The door and frame have no open holes or breaks in their surfaces." },
  { key: "glazing", section: "5.2.4.2(3)", text: "Any glazing, the frames around it, and the beads that hold it are intact and fastened." },
  { key: "secure_aligned", section: "5.2.4.2(4)", text: "The door, frame, hinges, hardware, and any noncombustible threshold are secure, aligned, and working, with no obvious damage." },
  { key: "parts", section: "5.2.4.2(5)", text: "No required parts are missing or broken." },
  { key: "clearances", section: "5.2.4.2(6)", text: "Gaps meet the clearance rule for this door. The gap under the door is not over 3/4 inch, or 3/8 inch when the bottom of the door sits more than 38 inches above the finished floor. A listed product made to close a larger bottom gap is acceptable. Top and side gaps stay within the limit for this door." },
  { key: "self_closing", section: "5.2.4.2(7)", text: "From fully open, the door closes all the way by itself, or a listed automatic closer releases it so it can. A wedge or other block holding it open is not acceptable." },
  { key: "coordinator", section: "5.2.4.2(8)", text: "On a pair, the coordinator lets the inactive leaf close before the active leaf. Use N/A when there is no coordinator." },
  { key: "latching", section: "5.2.4.2(9)", text: "The latching hardware holds the door positively latched when it is closed." },
  { key: "hold_open", section: "5.2.4.2(10)", text: "Nothing added to the door or frame stops it from opening, closing, or latching. That includes a hold-open that is not a listed releasing device." },
  { key: "field_modifications", section: "5.2.4.2(11)", text: "No field change was made that voids the fire door listing." },
  { key: "gasketing", section: "5.2.4.2(12)", text: "Gasketing, meeting-edge protection, and edge seals, where this door has them, are present and intact. Use N/A when the door has none." },
  { key: "signage", section: "5.2.4.2(13)", text: "Signs on the door stay within the size and attachment limits for a fire door and are not placed on the glazing." },
];

export const COMPLETED_FIRE_DOOR_SQL =
  "inspection_type = 'fire_door_nfpa80' AND checklist_result->>'status' = 'complete'";

const RESULTS = new Set(["pass", "fail", "na"]);
const MAX_PHOTO_CHARS = 2_000_000;

export interface AssessedItem {
  key: string;
  result: "pass" | "fail" | "na";
  note: string | null;
  photoId: string | null;
  photoBase64: string | null;
}

export type ChecklistAssessment =
  | { ok: true; anyFail: boolean; items: AssessedItem[]; stored: { status: "complete"; items: Record<string, { result: string; note: string | null; photo_id: string | null }> } }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function assessFireDoorChecklist(raw: unknown, inspectorName: string | undefined, qualification: string | undefined, licenseNumber: string | undefined): ChecklistAssessment {
  if (!inspectorName?.trim()) return { ok: false, error: "inspector_name_required" };
  if (!qualification?.trim()) return { ok: false, error: "inspector_qualification_required" };
  if (!licenseNumber?.trim()) return { ok: false, error: "inspector_license_required" };
  const body = asRecord(raw);
  const itemsIn = asRecord(body?.items);
  if (!body || body.status !== "complete" || !itemsIn) return { ok: false, error: "checklist_incomplete" };

  const items: AssessedItem[] = [];
  for (const spec of NFPA80_ITEMS) {
    const row = asRecord(itemsIn[spec.key]);
    const result = typeof row?.result === "string" ? row.result : "";
    if (!RESULTS.has(result)) return { ok: false, error: "checklist_incomplete" };
    const note = typeof row?.note === "string" ? row.note.trim() : "";
    const photoId = typeof row?.photo_id === "string" && row.photo_id ? row.photo_id : null;
    let photoBase64: string | null = null;
    if (typeof row?.photo_base64 === "string" && row.photo_base64) {
      const cleaned = row.photo_base64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      if (cleaned.length > MAX_PHOTO_CHARS) return { ok: false, error: "photo_unreadable" };
      photoBase64 = cleaned;
    }
    if (result === "fail" && !note) return { ok: false, error: "fail_requires_note" };
    if (result === "fail" && !photoId && !photoBase64) return { ok: false, error: "fail_requires_photo" };
    items.push({ key: spec.key, result: result as AssessedItem["result"], note: note || null, photoId, photoBase64 });
  }

  const storedItems: Record<string, { result: string; note: string | null; photo_id: string | null }> = {};
  for (const item of items) storedItems[item.key] = { result: item.result, note: item.note, photo_id: item.photoId };
  return { ok: true, anyFail: items.some((item) => item.result === "fail"), items, stored: { status: "complete", items: storedItems } };
}

export function decodePhoto(base64: string): Buffer | null {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 24) return null;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    return png || jpeg ? bytes : null;
  } catch {
    return null;
  }
}
