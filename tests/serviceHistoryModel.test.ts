import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitServiceHistory, componentLabel } from "../field-app/src/lib/serviceHistory";
import { mapSnapshot, componentLabel as facilityLabel } from "../facility-dashboard/api-client.mjs";

const opening = {
  id: "o1", opening_code: "QA-PAIR",
  door_leaves: [{ id: "la", leaf_role: "active" }, { id: "li", leaf_role: "inactive" }],
  hardware_components: [
    { id: "ca", component_type: "closer", door_leaf_id: "la", mounting_scope: "door_leaf", manufacturer: "Cal-Royal", model_number: "CR441" },
    { id: "ci", component_type: "closer", door_leaf_id: "li", mounting_scope: "door_leaf", manufacturer: "Cal-Royal", model_number: "CR441" },
  ],
  service_events: [
    { id: "e0", hardware_component_id: null, event_date: "2026-10-01", work_performed: "opening" },
    { id: "e1", hardware_component_id: "ca", event_date: "2026-10-02", work_performed: "active" },
    { id: "e2", hardware_component_id: "ci", event_date: "2026-10-03", work_performed: "inactive" },
    { id: "e3", hardware_component_id: "ca", event_date: "2026-10-04", work_performed: "active again" },
    { id: "ex", hardware_component_id: "zz", event_date: "2026-10-05", work_performed: "not on this opening" },
  ],
};

describe("service history model", () => {
  it("keeps opening-level events apart and gives each closer only its own events, newest first", () => {
    const h = splitServiceHistory(opening);
    expect(h.openingLevel.map((e) => e.id)).toEqual(["e0"]);
    expect(h.byComponent.get("ca")!.map((e) => e.id)).toEqual(["e3", "e1"]);
    expect(h.byComponent.get("ci")!.map((e) => e.id)).toEqual(["e2"]);
    expect(h.unmatched.map((e) => e.id)).toEqual(["ex"]);
  });
  it("labels components the same way in the Field App, the Dashboard and the Facility Dashboard", () => {
    for (const c of opening.hardware_components) expect(facilityLabel(c, opening)).toBe(componentLabel(c, opening));
    expect(componentLabel(opening.hardware_components[0], opening)).toBe("Closer · active leaf · Cal-Royal CR441");
    const field = readFileSync("field-app/src/lib/serviceHistory.ts", "utf8");
    const dash = readFileSync("dashboard/src/lib/serviceHistory.ts", "utf8").split("\n").slice(1).join("\n");
    expect(dash).toBe(field);
  });
  it("facility dashboard rows carry the component of each event", () => {
    const rows = mapSnapshot({ id: "f1", openings: [opening] }).service_events;
    const by = Object.fromEntries(rows.map((r: any) => [r.id, [r.component_id, r.component_label]]));
    expect(by.e0).toEqual([null, null]);
    expect(by.e1).toEqual(["ca", "Closer · active leaf · Cal-Royal CR441"]);
    expect(by.e2).toEqual(["ci", "Closer · inactive leaf · Cal-Royal CR441"]);
    expect(by.ex).toEqual([null, "Component not on this opening"]);
  });
});
