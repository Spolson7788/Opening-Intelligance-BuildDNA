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

export function formatSize(width: unknown, height: unknown, thickness?: unknown): string {
  const parts = [width, height, thickness].filter((value) => value != null && value !== "" && Number(value) > 0).map((value) => formatInches(Number(value)));
  return parts.length ? parts.join(" × ") : "—";
}

export function unevenPair(leaves: Array<{ leaf_role?: string; width_in?: unknown }>): boolean {
  const active = Number(leaves.find((leaf) => leaf.leaf_role === "active")?.width_in);
  const inactive = Number(leaves.find((leaf) => leaf.leaf_role === "inactive")?.width_in);
  if (!Number.isFinite(active) || !Number.isFinite(inactive) || active <= 0 || inactive <= 0) return false;
  return Math.abs(active - inactive) > 0.01;
}
