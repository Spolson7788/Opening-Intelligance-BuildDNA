import { describe, expect, it, vi } from "vitest";
import { haversineMiles, mapsLink, orderByNearest, planDrive, prefersAppleMaps, straightLineMinutes, straightLinePlan } from "../src/services/driveTime";

const phoenix = [
  { id: "west", latitude: 33.45, longitude: -112.2 },
  { id: "near", latitude: 33.46, longitude: -112.19 },
  { id: "far", latitude: 33.7, longitude: -111.8 },
];

describe("drive time ordering", () => {
  it("estimates a short Phoenix hop as a few minutes, not a road claim", () => {
    const miles = haversineMiles(phoenix[0], phoenix[1]);
    expect(miles).toBeGreaterThan(0);
    expect(miles).toBeLessThan(3);
    expect(straightLineMinutes(miles)).toBeGreaterThan(0);
    expect(straightLineMinutes(miles)).toBeLessThan(15);
  });

  it("starts at the first stop and visits the nearer stop before the farther one", () => {
    const plan = straightLinePlan(phoenix);
    expect(plan.source).toBe("straight_line");
    expect(plan.label).toMatch(/Straight-line estimate/);
    expect(plan.order).toEqual(["west", "near", "far"]);
    expect(plan.legs).toHaveLength(2);
    expect(plan.total_minutes).toBe((plan.legs[0].minutes ?? 0) + (plan.legs[1].minutes ?? 0));
    expect(plan.legs[0].minutes!).toBeLessThan(plan.legs[1].minutes!);
  });

  it("leaves a stop without a map location off the drive time", () => {
    const plan = straightLinePlan([...phoenix, { id: "unknown", latitude: null, longitude: null }]);
    expect(plan.order.at(-1)).toBe("unknown");
    expect(plan.legs.every((leg) => leg.to_id !== "unknown")).toBe(true);
  });

  it("uses Google minutes when a key is configured and never returns the key", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "OK",
        rows: phoenix.map((_, from) => ({
          elements: phoenix.map((_, to) => ({ status: "OK", duration: { value: from === to ? 0 : (Math.abs(from - to) === 1 ? 600 : 3600) } })),
        })),
      }),
    }));
    const plan = await planDrive(phoenix, "secret-key-value", fetchImpl as unknown as typeof fetch);
    expect(plan.source).toBe("google");
    expect(plan.label).toBe("Google drive time.");
    expect(JSON.stringify(plan)).not.toContain("secret-key-value");
    const called = String(fetchImpl.mock.calls[0][0]);
    expect(called).toContain("secret-key-value");
    expect(called).toContain("distancematrix");
  });

  it("falls back to the straight-line estimate when Google does not answer", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network down with secret-key-value"); });
    const plan = await planDrive(phoenix, "secret-key-value", fetchImpl as unknown as typeof fetch);
    expect(plan.source).toBe("straight_line");
    expect(JSON.stringify(plan)).not.toContain("secret-key-value");
  });

  it("opens Apple Maps on an iPhone and Google Maps otherwise", () => {
    expect(prefersAppleMaps("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
    expect(prefersAppleMaps("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
    expect(mapsLink("410 Market Street, Phoenix, AZ", true)).toBe("https://maps.apple.com/?daddr=410%20Market%20Street%2C%20Phoenix%2C%20AZ");
    expect(mapsLink("410 Market Street", false)).toContain("google.com/maps/dir/");
  });

  it("orders from a supplied minute table", () => {
    const ordered = orderByNearest(
      [{ id: "a", latitude: 1, longitude: 1 }, { id: "b", latitude: 2, longitude: 2 }, { id: "c", latitude: 3, longitude: 3 }],
      (from, to) => (from === "a" && to === "c" ? 5 : 20),
    );
    expect(ordered.order.slice(0, 2)).toEqual(["a", "c"]);
  });
});
