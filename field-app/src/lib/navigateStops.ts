// Google Maps directions for a whole day. Apple Maps cannot take this many stops.
// Origin is the phone's current location. Up to 9 waypoints plus the destination.

export type NavStop = {
  done?: boolean;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export const NAVIGATE_STOP_CAP = 10;
export const NAVIGATE_CAP_NOTE = "Opens the next 10 stops. Tap again after those are done.";
export const APPLE_MAPS_NOTE = "Apple Maps only takes one stop at a time, so use Open in Maps on each stop for Apple Maps.";

export function stopPlace(stop: NavStop): string | null {
  const address = stop.address?.trim();
  if (address) return address;
  if (typeof stop.latitude === "number" && Number.isFinite(stop.latitude) && typeof stop.longitude === "number" && Number.isFinite(stop.longitude)) {
    return `${stop.latitude},${stop.longitude}`;
  }
  return null;
}

export function googleStopUrl(stop: NavStop): string | null {
  const place = stopPlace(stop);
  if (!place) return null;
  const params = new URLSearchParams();
  params.set("api", "1");
  params.set("destination", place);
  params.set("travelmode", "driving");
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function navigateAllStops(stops: NavStop[]): { url: string | null; capped: boolean } {
  const places: string[] = [];
  for (const stop of stops) {
    if (stop.done) continue;
    const place = stopPlace(stop);
    if (place) places.push(place);
  }
  if (!places.length) return { url: null, capped: false };
  const capped = places.length > NAVIGATE_STOP_CAP;
  const batch = places.slice(0, NAVIGATE_STOP_CAP);
  const destination = batch[batch.length - 1];
  const waypoints = batch.slice(0, -1);
  const params = new URLSearchParams();
  params.set("api", "1");
  params.set("origin", "Current Location");
  params.set("destination", destination);
  if (waypoints.length) params.set("waypoints", waypoints.join("|"));
  params.set("travelmode", "driving");
  return { url: `https://www.google.com/maps/dir/?${params.toString()}`, capped };
}
