// Swinging fire door annual inspection items. Wording is ours.
// Section numbers point at NFPA 80 (2022) 5.2.3 so a reader can look up the rule.
// The standard's sentences are not copied here.

export interface Nfpa80Item {
  key: string;
  section: string;
  text: string;
}

export const NFPA80_ITEMS: Nfpa80Item[] = [
  { key: "labels", section: "5.2.3.1", text: "The fire door and frame labels are in place and can be read." },
  { key: "holes_breaks", section: "5.2.3.2", text: "The door and frame have no open holes or breaks in their surfaces." },
  { key: "glazing", section: "5.2.3.3", text: "Glazing and the frames that hold it are intact." },
  { key: "secure_aligned", section: "5.2.3.4", text: "The door, frame, hinges, hardware, and any noncombustible threshold are secure, aligned, and in working order." },
  { key: "parts", section: "5.2.3.5", text: "No required parts are missing or broken." },
  { key: "clearances", section: "5.2.3.6", text: "Clearances are within the limit used for this inspection: the gap under the door is not over 3/4 inch, and the top and side gaps meet the clearance rule for this door." },
  { key: "self_closing", section: "5.2.3.7", text: "The door closes itself all the way from the open position." },
  { key: "coordinator", section: "5.2.3.8", text: "On a pair of doors, the coordinator lets the inactive leaf close before the active leaf. Use N/A when there is no coordinator." },
  { key: "latching", section: "5.2.3.9", text: "The latching hardware holds the door positively latched." },
  { key: "hold_open", section: "5.2.3.10", text: "No hold-open device is installed unless it is a listed releasing device." },
  { key: "field_modifications", section: "5.2.3.11", text: "No field change that affects the fire rating was made without a documented approval." },
  { key: "gasketing", section: "5.2.3.12", text: "Gasketing and edge seals, where this door has them, are in place and not damaged. Use N/A when the door has none." },
  { key: "signage", section: "5.2.3.13", text: "Signs on the door meet the attachment and coverage limits for a fire door." },
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

export function assessFireDoorChecklist(raw: unknown, inspectorName: string | undefined, qualification: string | undefined): ChecklistAssessment {
  if (!inspectorName?.trim()) return { ok: false, error: "inspector_name_required" };
  if (!qualification?.trim()) return { ok: false, error: "inspector_qualification_required" };
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
