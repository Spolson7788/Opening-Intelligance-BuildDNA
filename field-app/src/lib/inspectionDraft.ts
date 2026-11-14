export type DraftAnswer = { result: "" | "pass" | "fail" | "na"; note: string };

const key = (openingId: string) => `oi-inspect-draft:${openingId}`;
const photos = new Map<string, File>();

export function readInspectDraft(openingId: string): Record<string, DraftAnswer> {
  try {
    const raw = sessionStorage.getItem(key(openingId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DraftAnswer>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeInspectDraft(openingId: string, answers: Record<string, { result?: DraftAnswer["result"]; note?: string }>) {
  const stored: Record<string, DraftAnswer> = {};
  for (const [item, value] of Object.entries(answers)) {
    if (value?.result !== "pass" && value?.result !== "fail" && value?.result !== "na") continue;
    stored[item] = { result: value.result, note: value.note || "" };
  }
  sessionStorage.setItem(key(openingId), JSON.stringify(stored));
}

export function rememberInspectPhoto(openingId: string, itemKey: string, file: File) {
  photos.set(`${openingId}:${itemKey}`, file);
}

export function inspectPhoto(openingId: string, itemKey: string): File | null {
  return photos.get(`${openingId}:${itemKey}`) ?? null;
}

export function clearInspectDraft(openingId: string) {
  try { sessionStorage.removeItem(key(openingId)); } catch { /* the inspection is already saved */ }
  for (const item of [...photos.keys()]) {
    if (item.startsWith(`${openingId}:`)) photos.delete(item);
  }
}
