import { describe, expect, it } from "vitest";
import { googleStopUrl, navigateAllStops } from "../field-app/src/lib/navigateStops";

const west = { address: "West yard Street, Phoenix, AZ", latitude: 33.45, longitude: -112.07 };
const near = { address: null, latitude: 33.5, longitude: -112.07 };
const far = { address: "Far plant Street, Phoenix, AZ", latitude: 33.8, longitude: -112.07 };

describe("navigate all stops", () => {
  it("keeps unfinished stops in route order, with the last as the destination", () => {
    const result = navigateAllStops([
      west,
      { done: true, address: "Done Street, Phoenix, AZ", latitude: 1, longitude: 1 },
      near,
      { address: "   ", latitude: null, longitude: null },
      far,
    ]);
    expect(result.capped).toBe(false);
    const url = new URL(result.url!);
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("origin")).toBe("Current Location");
    expect(url.searchParams.get("travelmode")).toBe("driving");
    expect(url.searchParams.get("waypoints")).toBe("West yard Street, Phoenix, AZ|33.5,-112.07");
    expect(url.searchParams.get("destination")).toBe("Far plant Street, Phoenix, AZ");
    expect(url.searchParams.get("waypoints")).not.toContain("33.45");
    expect(result.url).not.toContain("Done Street");
    expect(result.url).toContain("West+yard+Street%2C+Phoenix%2C+AZ");
    expect(result.url).toContain("33.5%2C-112.07");
  });

  it("encodes characters that would break the query", () => {
    const result = navigateAllStops([{ address: "A & B, Phoenix", latitude: null, longitude: null }]);
    expect(result.url).toContain("destination=A+%26+B%2C+Phoenix");
    expect(result.url).not.toContain("destination=A & B");
    expect(new URL(result.url!).searchParams.get("waypoints")).toBeNull();
  });

  it("sends only the next 10 unfinished stops", () => {
    const stops = Array.from({ length: 12 }, (_, index) => ({ address: `Stop ${index + 1}`, latitude: index, longitude: index }));
    const result = navigateAllStops(stops);
    expect(result.capped).toBe(true);
    const url = new URL(result.url!);
    expect(url.searchParams.get("destination")).toBe("Stop 10");
    const waypoints = url.searchParams.get("waypoints")!.split("|");
    expect(waypoints).toEqual(Array.from({ length: 9 }, (_, index) => `Stop ${index + 1}`));
    expect(result.url).not.toContain("Stop+11");
    expect(result.url).not.toContain("Stop+12");
  });

  it("has no link when every remaining stop is done or has no location", () => {
    expect(navigateAllStops([])).toEqual({ url: null, capped: false });
    expect(navigateAllStops([
      { done: true, address: "Done Street", latitude: 1, longitude: 2 },
      { address: "", latitude: null, longitude: null },
    ])).toEqual({ url: null, capped: false });
    expect(googleStopUrl({ address: null, latitude: 33.5, longitude: -112.07 })).toContain("destination=33.5%2C-112.07");
    expect(googleStopUrl({ address: "   ", latitude: null, longitude: null })).toBeNull();
  });
});
