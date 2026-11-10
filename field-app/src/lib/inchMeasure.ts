/** Feet, inches, and fractions to decimal inches. Blank is null. 3' 11 1/2", 47.5, and 47 1/2 are accepted. */
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

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function formatInches(inches: number): string {
  if (!Number.isFinite(inches) || inches <= 0) return "";
  const total = Math.round(inches * 16) / 16;
  const feet = Math.floor(total / 12);
  const remainder = Math.round((total - feet * 12) * 16) / 16;
  const whole = Math.floor(remainder + 1e-9);
  const sixteenths = Math.round((remainder - whole) * 16);
  let frac = "";
  if (sixteenths > 0) {
    const divisor = gcd(sixteenths, 16);
    frac = ` ${sixteenths / divisor}/${16 / divisor}`;
  }
  const inchText = `${whole}${frac}`;
  return feet > 0 ? `${feet}' ${inchText}"` : `${inchText}"`;
}

export function unevenPair(activeIn: number | null | undefined, inactiveIn: number | null | undefined): boolean {
  if (activeIn == null || inactiveIn == null) return false;
  const active = Number(activeIn);
  const inactive = Number(inactiveIn);
  if (!Number.isFinite(active) || !Number.isFinite(inactive)) return false;
  return Math.abs(active - inactive) > 0.01;
}

export type DimensionDraft = { text: string; clear: boolean };

export function dimensionDraft(stored: number | null | undefined): DimensionDraft {
  const value = stored == null ? null : Number(stored);
  return { text: value != null && Number.isFinite(value) && value > 0 ? formatInches(value) : "", clear: false };
}

/** Blank leaves the stored value alone. Clear is the only way to send null. */
export function dimensionPayload(draft: DimensionDraft): { set: boolean; value: number | null } {
  if (draft.clear) return { set: true, value: null };
  if (!draft.text.trim()) return { set: false, value: null };
  const inches = parseInches(draft.text);
  if (inches == null) throw new Error("unreadable_dimension");
  return { set: true, value: inches };
}
