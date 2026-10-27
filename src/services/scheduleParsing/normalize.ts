// Value normalization shared by door and hardware schedule parsers.

/** Door marks are text: "103", "108a" -> "108A", "E1", "S301". Never numbers. */
export function normalizeMark(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ""); // spreadsheet numeric cell 103.0
  s = s.replace(/[.,;]+$/, "").toUpperCase();
  return s.length > 0 && s.length <= 40 ? s : null;
}

/** Feet/inch strings to inches: 3' - 0" -> 36, 0' - 1 3/4" -> 1.75, 7'-10 1/2" -> 94.5, 36 -> 36. */
export function parseInches(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[\u2019\u2032]/g, "'").replace(/[\u201d\u2033]|''/g, '"').trim();
  if (!s) return null;
  const ft = /^(\d+(?:\.\d+)?)\s*'\s*(?:-\s*)?(.*)$/.exec(s);
  let feet = 0, rest = s;
  if (ft) { feet = parseFloat(ft[1]); rest = ft[2]; }
  rest = rest.replace(/"/g, "").replace(/\s*-\s*/g, " ").trim();
  let inches = 0;
  if (rest) {
    const m = /^(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?|(\d+)\/(\d+))$/.exec(rest);
    if (!m) return null;
    if (m[4]) inches = parseInt(m[4], 10) / parseInt(m[5], 10);
    else { inches = parseFloat(m[1]); if (m[2]) inches += parseInt(m[2], 10) / parseInt(m[3], 10); }
  } else if (!ft) return null;
  const total = feet * 12 + inches;
  return Number.isFinite(total) && total > 0 && total < 1200 ? Math.round(total * 1000) / 1000 : null;
}

/** "0 MIN" -> 0, "90 Min" -> 90, "1 HR" -> 60, "1-1/2 HR" -> 90, "20 MIN." -> 20. */
export function parseFireMinutes(raw: string | null | undefined): number | null | "invalid" {
  if (raw == null || !String(raw).trim()) return null;
  const s = String(raw).trim().toUpperCase();
  let m = /^(\d+)\s*-?\s*MIN(UTES?)?\.?$/.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /^(\d+)(?:\s*-\s*|\s+)?(?:(\d+)\/(\d+))?\s*-?\s*(HR|HOUR|HRS|HOURS)\.?$/.exec(s);
  if (m) return Math.round((parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0)) * 60);
  if (/^(NR|NONE|N\/A|-)$/.test(s)) return 0;
  return "invalid";
}

/** "Group 29" -> "29", "Group X" -> "X", "HW-5" -> "5", "<varies>" -> null. */
export function parseHardwareRef(raw: string | null | undefined): { key: string | null; varies: boolean } {
  const s = String(raw ?? "").trim();
  if (!s) return { key: null, varies: false };
  if (/^<?\s*varies\s*>?$/i.test(s)) return { key: null, varies: true };
  const m = /^(?:hw\s*(?:set|group)?|hardware\s*(?:set|group)?|group|set)\s*[:#-]?\s*(.+)$/i.exec(s);
  return { key: normalizeSetKey(m ? m[1] : s), varies: false };
}

export function normalizeSetKey(raw: string): string | null {
  const s = raw.replace(/\s+/g, "").replace(/[.:]+$/, "").toUpperCase();
  return s.length > 0 && s.length <= 40 ? s : null;
}

/** "ENTRY VESTIBULE-101" -> name ENTRY VESTIBULE, number 101. */
export function splitRoom(raw: string | null | undefined): { name: string | null; number: string | null } {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { name: null, number: null };
  const m = /^(.*?)\s*-\s*([A-Z]?\d+[A-Z]?)$/i.exec(s);
  return m && m[1] ? { name: m[1], number: m[2].toUpperCase() } : { name: s, number: null };
}

export function clean(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s ? s : null;
}
