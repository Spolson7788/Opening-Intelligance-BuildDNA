import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";

const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>(), puts: 0 }));
vi.mock("../src/services/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/storage")>();
  return {
    ...actual,
    putPrivateBytes: async (key: string, bytes: Uint8Array) => {
      storage.puts += 1;
      const copy = Buffer.from(bytes);
      storage.objects.set(key, copy);
      return { etag: "visit-pdf", sha256: createHash("sha256").update(copy).digest("hex"), byteSize: copy.length };
    },
    getObjectBytes: async (key: string) => {
      const found = storage.objects.get(key);
      if (!found) throw new Error("object_missing");
      return found;
    },
  };
});

import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";
import { failingFireDoorFields, passingFireDoorFields } from "./nfpa80Fixture";
import { setEmailProviderForTests } from "../src/services/email";
import { visitInspectionsShortfall } from "../src/services/inspectionVisits";
import { pool } from "../src/db/pool";

afterEach(() => setEmailProviderForTests(null));

async function inspectorToken(adminToken: string) {
  const email = `inspector-${Date.now()}-${randomUUID().slice(0, 8)}@example.invalid`;
  const registered = await request(app).post("/api/auth/register").set("Authorization", `Bearer ${adminToken}`).send({
    email, password: "password12345", full_name: "Inspector", role: "inspector",
  });
  expect(registered.status).toBeLessThan(300);
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

it("groups two openings into one visit and keeps the combined report inside the company", async () => {
  const org = await signupTestOrg("Visit clinic");
  const other = await signupTestOrg("Other clinic");
  const { buildingId, propertyId, portfolioId } = await createPortfolioHierarchy(org.token);
  const second = await request(app).post("/api/portfolio/properties").set("Authorization", `Bearer ${org.token}`).send({
    portfolio_id: portfolioId, name: "Other site", property_type: "multifamily",
  });
  const otherBuilding = await request(app).post("/api/portfolio/buildings").set("Authorization", `Bearer ${org.token}`).send({ property_id: second.body.id, name: "Annex" });
  const failed = await createTestOpening(org.token, buildingId, { opening_code: "FAIL-1", fire_rated: true });
  const passed = await createTestOpening(org.token, buildingId, { opening_code: "PASS-1", fire_rated: true });
  const elsewhere = await createTestOpening(org.token, otherBuilding.body.id, { opening_code: "OTHER-1", fire_rated: true });
  await request(app).put(`/api/portfolio/properties/${propertyId}/contact-email`).set("Authorization", `Bearer ${org.token}`).send({ contact_email: "building@example.com" });
  const visitId = randomUUID();
  const auth = { Authorization: `Bearer ${org.token}` };
  const failPost = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: failed.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...failingFireDoorFields("Hole in the face"),
  });
  expect(failPost.status).toBe(201);
  expect(failPost.body.visit_id).toBe(visitId);
  const passPost = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: passed.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(passPost.status).toBe(201);
  const mismatch = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: elsewhere.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(mismatch.status).toBe(409);
  expect(mismatch.body.error).toBe("visit_facility_mismatch");

  const summary = await request(app).get(`/api/events/inspection-visits/${visitId}`).set(auth);
  expect(summary.status).toBe(200);
  expect(summary.body.summary).toBe("This visit: 2 openings (1 passed, 1 failed)");
  expect(summary.body.doors.map((door: { opening_code: string }) => door.opening_code)).toEqual(expect.arrayContaining(["FAIL-1", "PASS-1"]));

  const pdf = await request(app).get(`/api/events/inspection-visits/${visitId}/report.pdf`).set(auth);
  expect(pdf.status).toBe(200);
  expect(pdf.body.slice(0, 4).toString()).toBe("%PDF");

  const defaults = await request(app).get(`/api/events/inspection-visits/${visitId}/email-defaults`).set(auth);
  expect(defaults.body.to).toEqual(["building@example.com", org.email]);

  const syncedId = randomUUID();
  const syncedOpening = await createTestOpening(org.token, buildingId, { opening_code: "SYNC-1", fire_rated: true });
  const synced = await request(app).post("/api/sync/operations").set(auth).send({
    operation_id: syncedId, operation_type: "create", entity_id: syncedId, entity_type: "inspection_event",
    opening_id: syncedOpening.id, device_id: randomUUID(), base_server_revision: null, schema_version: 3,
    app_version: "visit", protocol_version: 1,
    payload: { event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields() },
  });
  expect(synced.status).toBe(201);
  const again = await request(app).get(`/api/events/inspection-visits/${visitId}`).set(auth);
  expect(again.body.inspected).toBe(3);

  const sent: { subject?: string; attachments?: { filename: string }[] }[] = [];
  setEmailProviderForTests({ name: "fake", send: async (message) => { sent.push(message); return { sent: true }; } });
  const mailed = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({ to: ["building@example.com", org.email] });
  expect(mailed.status).toBe(200);
  expect(sent[0].attachments?.[0].filename).toBe("fire-door-inspection-visit.pdf");

  expect((await request(app).get(`/api/events/inspection-visits/${visitId}`).set("Authorization", `Bearer ${other.token}`)).status).toBe(404);
  const office = await request(app).get(`/api/portfolio/inspection-visits/${visitId}`).set(auth);
  expect(office.status).toBe(200);
  expect(office.body.failed).toBe(1);
  const inspector = await inspectorToken(org.token);
  const denied = await request(app).get(`/api/portfolio/inspection-visits/${visitId}`).set("Authorization", `Bearer ${inspector}`);
  expect(denied.status).toBe(403);
  expect(denied.body).toEqual({ error: "facility_dashboard_forbidden" });
  expect((await request(app).get(`/api/events/inspection-visits/${visitId}`).set("Authorization", `Bearer ${inspector}`)).status).toBe(200);

  const before = storage.puts;
  const firstSha = createHash("sha256").update([...storage.objects.values()][0]).digest("hex");
  await pool.query("UPDATE fire_door_deficiencies SET note='Changed after the official report' WHERE inspection_event_id=$1", [failPost.body.id]);
  const resent = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({ to: ["building@example.com"] });
  expect(resent.status).toBe(200);
  expect(storage.puts).toBe(before);
  const stored = [...storage.objects.values()][0];
  expect(createHash("sha256").update(stored).digest("hex")).toBe(firstSha);
  expect(stored.toString("latin1")).not.toContain("Changed after the official report");
  const list = await request(app).get("/api/portfolio/inspection-visits").set(auth);
  expect(list.status).toBe(200);
  expect(list.body.visits.some((row: { id: string; report_sent: boolean; failed: number; inspector_name: string }) => row.id === visitId && row.report_sent && row.failed >= 1 && row.inspector_name === "Test Inspector")).toBe(true);
  expect((await request(app).get("/api/portfolio/inspection-visits").set("Authorization", `Bearer ${inspector}`)).status).toBe(403);
  expect((await request(app).get("/api/portfolio/inspection-visits").set("Authorization", `Bearer ${other.token}`)).body.visits).toEqual([]);
  const opening = await request(app).get(`/api/openings/${failed.id}`).set(auth);
  expect(opening.body.inspection_events[0].visit_id).toBe(visitId);
});

it("does not freeze the official PDF when a later door in the visit has not reached the server", async () => {
  expect(visitInspectionsShortfall(["door-210a"], ["door-210a", "door-310a"])).toBe(1);
  expect(visitInspectionsShortfall(["door-210a", "door-310a"], ["door-210a", "door-310a"])).toBe(0);
  const org = await signupTestOrg("Race clinic");
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const first = await createTestOpening(org.token, buildingId, { opening_code: "210A", fire_rated: true });
  const second = await createTestOpening(org.token, buildingId, { opening_code: "310A", fire_rated: true });
  const visitId = randomUUID();
  const auth = { Authorization: `Bearer ${org.token}` };
  const early = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: first.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(early.status).toBe(201);
  const lateId = randomUUID();
  setEmailProviderForTests({ name: "fake", send: async () => ({ sent: true }) });
  const puts = storage.puts;
  const blocked = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({
    to: ["building@example.com"],
    expected_inspection_ids: [early.body.id, lateId],
  });
  expect(blocked.status).toBe(409);
  expect(blocked.body).toEqual({ error: "visit_inspections_pending", pending: 1 });
  expect(storage.puts).toBe(puts);
  expect((await pool.query("SELECT report_storage_key FROM inspection_visits WHERE id=$1", [visitId])).rows[0].report_storage_key).toBeNull();

  const arrived = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: second.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(arrived.status).toBe(201);
  const mailed = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({
    to: ["building@example.com"],
    expected_inspection_ids: [early.body.id, arrived.body.id],
  });
  expect(mailed.status).toBe(200);
  expect(storage.puts).toBe(puts + 1);
  const resent = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({
    to: ["building@example.com"],
    expected_inspection_ids: [early.body.id, lateId, randomUUID()],
  });
  expect(resent.status).toBe(200);
  expect(storage.puts).toBe(puts + 1);
});

it("rejects a new inspection on a finished visit and keeps the official PDF", async () => {
  const org = await signupTestOrg("Finished visit");
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const first = await createTestOpening(org.token, buildingId, { opening_code: `FIN-${randomUUID().slice(0, 8)}`, fire_rated: true });
  const later = await createTestOpening(org.token, buildingId, { opening_code: `LATER-${randomUUID().slice(0, 8)}`, fire_rated: true });
  const visitId = randomUUID();
  const auth = { Authorization: `Bearer ${org.token}` };
  const saved = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: first.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(saved.status).toBe(201);
  setEmailProviderForTests({ name: "fake", send: async () => ({ sent: true }) });
  const puts = storage.puts;
  const mailed = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({
    to: ["building@example.com"], expected_inspection_ids: [saved.body.id],
  });
  expect(mailed.status).toBe(200);
  const closed = await request(app).get(`/api/events/inspection-visits/${visitId}`).set(auth);
  expect(closed.body.status).toBe("finished");
  expect(closed.body.report_sent).toBe(true);
  const refused = await request(app).post("/api/events/inspection-events").set(auth).send({
    opening_id: later.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("visit_finished");
  expect((await pool.query("SELECT id FROM inspection_events WHERE opening_id=$1", [later.id])).rowCount).toBe(0);
  const queuedId = randomUUID();
  const synced = await request(app).post("/api/sync/operations").set(auth).send({
    operation_id: queuedId, operation_type: "create", entity_id: queuedId, entity_type: "inspection_event",
    opening_id: later.id, device_id: randomUUID(), base_server_revision: null, schema_version: 3,
    app_version: "visit", protocol_version: 1,
    payload: { event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields() },
  });
  expect(synced.status).toBe(409);
  expect(synced.body.error).toBe("visit_finished");
  expect((await pool.query("SELECT id FROM inspection_events WHERE id=$1", [queuedId])).rowCount).toBe(0);
  const again = await request(app).post(`/api/events/inspection-visits/${visitId}/email`).set(auth).send({ to: ["building@example.com"] });
  expect(again.status).toBe(200);
  expect(storage.puts).toBe(puts + 1);
});
