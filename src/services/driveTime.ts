// Drive-time ordering for a provider's day. Google is used only when a key is passed in.
// The key is never returned or included in an error message. Without a key, or if Google
// does not answer, the order is a straight-line estimate from latitude and longitude.

export type StopPoint = { id: string; latitude: number | null; longitude: number | null };

export type DriveLeg = { from_id: string; to_id: string; minutes: number | null };

export type DrivePlan = {
  order: string[];
  legs: DriveLeg[];
  total_minutes: number;
  source: "google" | "straight_line";
  label: string;
};

const EARTH_MILES = 3958.8;
const ROAD_FACTOR = 1.3;
const CITY_MPH = 30;

export function haversineMiles(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function straightLineMinutes(miles: number): number {
  return Math.max(1, Math.round((miles * ROAD_FACTOR) / CITY_MPH * 60));
}

function located(point: StopPoint): point is StopPoint & { latitude: number; longitude: number } {
  return typeof point.latitude === "number" && typeof point.longitude === "number" && Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

export function orderByNearest(points: StopPoint[], minutesBetween: (fromId: string, toId: string) => number | null): { order: string[]; legs: DriveLeg[] } {
  const withMap = points.filter(located);
  const withoutMap = points.filter((point) => !located(point));
  if (!withMap.length) {
    return { order: withoutMap.map((point) => point.id), legs: [] };
  }
  const remaining = new Map(withMap.map((point) => [point.id, point]));
  const start = withMap[0];
  remaining.delete(start.id);
  const order = [start.id];
  const legs: DriveLeg[] = [];
  let current = start.id;
  while (remaining.size) {
    let nextId = "";
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of remaining.values()) {
      const minutes = minutesBetween(current, candidate.id);
      const score = minutes ?? Number.POSITIVE_INFINITY;
      if (score < best) {
        best = score;
        nextId = candidate.id;
      }
    }
    if (!nextId) nextId = remaining.keys().next().value as string;
    const minutes = minutesBetween(current, nextId);
    legs.push({ from_id: current, to_id: nextId, minutes });
    order.push(nextId);
    remaining.delete(nextId);
    current = nextId;
  }
  order.push(...withoutMap.map((point) => point.id));
  return { order, legs };
}

export function straightLinePlan(points: StopPoint[]): DrivePlan {
  const lookup = new Map(points.filter(located).map((point) => [point.id, point]));
  const planned = orderByNearest(points, (fromId, toId) => {
    const from = lookup.get(fromId);
    const to = lookup.get(toId);
    if (!from || !to) return null;
    return straightLineMinutes(haversineMiles(from, to));
  });
  const total = planned.legs.reduce((sum, leg) => sum + (leg.minutes ?? 0), 0);
  return {
    ...planned,
    total_minutes: total,
    source: "straight_line",
    label: "Straight-line estimate from the map location, not a road route. About 30 miles an hour.",
  };
}

type GoogleMatrix = { status?: string; rows?: Array<{ elements?: Array<{ status?: string; duration?: { value?: number } }> }> };

export async function googleDrivePlan(points: StopPoint[], apiKey: string, fetchImpl: typeof fetch = fetch): Promise<DrivePlan | null> {
  const placed = points.filter(located);
  if (placed.length < 2 || !apiKey) return null;
  const coords = placed.map((point) => `${point.latitude},${point.longitude}`).join("|");
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", coords);
  url.searchParams.set("destinations", coords);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", apiKey);
  let body: GoogleMatrix;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    body = await response.json() as GoogleMatrix;
  } catch {
    return null;
  }
  if (body.status !== "OK" || !body.rows || body.rows.length !== placed.length) return null;
  for (const row of body.rows) {
    if (row.elements?.length !== placed.length || row.elements.some((element) => element.status !== "OK")) return null;
  }
  const index = new Map(placed.map((point, position) => [point.id, position]));
  const plan = orderByNearest(points, (fromId, toId) => {
    const from = index.get(fromId);
    const to = index.get(toId);
    if (from === undefined || to === undefined) return null;
    const element = body.rows?.[from]?.elements?.[to];
    if (!element || element.status !== "OK" || typeof element.duration?.value !== "number") return null;
    return Math.max(1, Math.round(element.duration.value / 60));
  });
  return {
    ...plan,
    total_minutes: plan.legs.reduce((sum, leg) => sum + (leg.minutes ?? 0), 0),
    source: "google",
    label: "Google drive time.",
  };
}

export async function planDrive(points: StopPoint[], apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<DrivePlan> {
  if (apiKey) {
    const google = await googleDrivePlan(points, apiKey, fetchImpl);
    if (google) return google;
  }
  return straightLinePlan(points);
}

export function mapsLink(address: string, apple: boolean): string {
  const query = encodeURIComponent(address);
  return apple
    ? `https://maps.apple.com/?daddr=${query}`
    : `https://www.google.com/maps/dir/?api=1&destination=${query}`;
}

export function prefersAppleMaps(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent);
}
