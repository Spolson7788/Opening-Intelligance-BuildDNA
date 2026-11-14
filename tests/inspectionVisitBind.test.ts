import { expect, it } from "vitest";
import { bindInspectionVisit } from "../src/services/inspectionVisits";

const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = "3d45de85-76b6-4113-92b0-2dc67842e16b";
const property = "c9d8e9e6-361d-4b95-b20b-cb06263775c9";
const opening = "11111111-1111-4111-8111-111111111111";
const inspection = "22222222-2222-4222-8222-222222222222";
const openVisit = "191f5a79-1534-49fb-b486-c4bff94195b7";
const freshVisit = "33333333-3333-4333-8333-333333333333";

function database(openIds: string[]) {
  const visits = new Map(openIds.map((id) => [id, { id, organization_id: org, property_id: property, inspector_user_id: user, status: "open" }]));
  const bound: { visitId: string; inspectionId: string }[] = [];
  return {
    bound,
    visits,
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM openings")) return { rows: [{ property_id: property }] };
      if (sql.includes("status = 'open'") && sql.startsWith("SELECT id")) {
        const ids = [...visits.values()].filter((visit) => visit.status === "open").map((visit) => visit.id);
        return { rows: ids.length ? [{ id: ids[ids.length - 1] }] : [] };
      }
      if (sql.startsWith("UPDATE inspection_visits")) {
        const keep = params[3];
        for (const visit of visits.values()) if (visit.status === "open" && visit.id !== keep) visit.status = "finished";
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id, status")) {
        const visit = visits.get(String(params[0]));
        return { rows: visit ? [{ id: visit.id, status: visit.status }] : [] };
      }
      if (sql.startsWith("SELECT organization_id")) {
        const visit = visits.get(String(params[0]));
        return { rows: visit ? [visit] : [] };
      }
      if (sql.startsWith("INSERT INTO inspection_visits")) {
        visits.set(String(params[0]), { id: String(params[0]), organization_id: org, property_id: property, inspector_user_id: user, status: "open" });
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE inspection_events")) {
        bound.push({ visitId: String(params[0]), inspectionId: String(params[1]) });
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

it("attaches a new visit id to the open visit and returns that id", async () => {
  const db = database([openVisit]);
  const result = await bindInspectionVisit(db, { visitId: freshVisit, inspectionId: inspection, openingId: opening, organizationId: org, userId: user });
  expect(result).toEqual({ visitId: openVisit });
  expect(db.bound).toEqual([{ visitId: openVisit, inspectionId: inspection }]);
  expect(db.visits.has(freshVisit)).toBe(false);
  expect(db.visits.get(openVisit)?.status).toBe("open");
});

it("finishes the open visit when the phone starts a new one", async () => {
  const db = database([openVisit]);
  const result = await bindInspectionVisit(db, { visitId: freshVisit, inspectionId: inspection, openingId: opening, organizationId: org, userId: user, replaceOpenVisit: true });
  expect(result).toEqual({ visitId: freshVisit });
  expect(db.visits.get(openVisit)?.status).toBe("finished");
  expect(db.visits.get(freshVisit)?.status).toBe("open");
  expect([...db.visits.values()].filter((visit) => visit.status === "open")).toHaveLength(1);
});
