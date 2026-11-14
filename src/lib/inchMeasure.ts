import { parseInches } from "../services/scheduleParsing/normalize";

export { parseInches };

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Nearest 1/16 inch, shown as feet and inches: 47.5 -> 3' 11 1/2". */
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

export type LeafWidthPlan = {
  active: number | null;
  inactive: number | null;
  /** True when a pair width was split in half because the schedule did not give two leaf widths. */
  estimated: boolean;
};

function twoWidths(text: string): [number, number] | null {
  const parts = text.split(/\s*(?:\/|&|\band\b)\s*/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const left = parseInches(parts[0]);
  const right = parseInches(parts[1]);
  if (left == null || right == null) return null;
  return [left, right];
}

/** Pair leaf widths from an explicit pair of measurements, otherwise an even split marked estimated. */
export function pairLeafWidths(input: {
  pair: boolean;
  widthIn: number | null;
  texts?: Array<string | null | undefined>;
}): LeafWidthPlan {
  if (!input.pair) return { active: input.widthIn, inactive: null, estimated: false };
  for (const text of input.texts ?? []) {
    if (!text) continue;
    const found = twoWidths(text);
    if (found) return { active: found[0], inactive: found[1], estimated: false };
  }
  if (input.widthIn == null) return { active: null, inactive: null, estimated: false };
  const half = Math.round((Number(input.widthIn) / 2) * 1000) / 1000;
  return { active: half, inactive: half, estimated: true };
}

export function hasDimension(payload: object, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return false;
  return (payload as Record<string, unknown>)[key] !== undefined;
}

export function unevenPair(activeIn: number | null | undefined, inactiveIn: number | null | undefined): boolean {
  if (activeIn == null || inactiveIn == null) return false;
  const active = Number(activeIn);
  const inactive = Number(inactiveIn);
  if (!Number.isFinite(active) || !Number.isFinite(inactive)) return false;
  return Math.abs(active - inactive) > 0.01;
}
