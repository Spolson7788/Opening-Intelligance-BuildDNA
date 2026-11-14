import { NFPA80_ITEMS } from "../src/services/nfpa80Checklist";

export const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function passingFireDoorFields() {
  return {
    passed: true,
    signed_by_name: "Test Inspector",
    inspector_qualification: "Fire door inspector",
    inspector_license_number: "FD-100",
    checklist_result: {
      status: "complete",
      items: Object.fromEntries(NFPA80_ITEMS.map((item) => [item.key, { result: "pass" }])),
    },
  };
}

export function failingFireDoorFields(note = "The label is missing") {
  const items = Object.fromEntries(NFPA80_ITEMS.map((item) => [item.key, { result: "pass" }]));
  items[NFPA80_ITEMS[0].key] = { result: "fail", note, photo_base64: TINY_PNG_BASE64 };
  return {
    passed: false,
    signed_by_name: "Test Inspector",
    inspector_qualification: "Fire door inspector",
    inspector_license_number: "FD-100",
    checklist_result: { status: "complete", items },
  };
}
