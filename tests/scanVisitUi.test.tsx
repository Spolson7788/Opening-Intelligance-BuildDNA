// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  operations: [] as { entityId: string; entityType: string; state: string }[],
  server: { status: "open", report_sent: false, inspection_ids: ["insp-1"] } as { status: string; report_sent: boolean; inspection_ids: string[] } | null,
}));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class { start() { return Promise.reject(new Error("no camera")); } stop() { return Promise.resolve(); } },
}));
vi.mock("../field-app/src/components/SyncBadge", () => ({ SyncBadge: () => <span>Sync</span> }));
vi.mock("../field-app/src/components/FacilitySelector", () => ({ FacilitySelector: () => <p>Facilities</p> }));
vi.mock("../field-app/src/lib/AuthContext", () => ({ useAuth: () => ({ logout: () => {}, auth: { userId: "u", organizationId: "org" }, logoutPending: false, logoutError: null }) }));
vi.mock("../field-app/src/lib/api", () => ({
  fetchLabelConfig: async () => ({ field_base: "https://example.invalid/field/" }),
  fetchInspectionVisit: async () => {
    if (!store.server) throw new Error("offline");
    return store.server;
  },
}));
vi.mock("../field-app/src/lib/db", () => ({
  loadAuth: async () => ({ token: "t", userId: "u", organizationId: "org", role: "inspector" }),
  getOfflineSetting: async (key: string) => store.settings.has(key) ? { key, value: store.settings.get(key), updatedAt: "" } : undefined,
  putOfflineSetting: async (setting: { key: string; value: unknown }) => { store.settings.set(setting.key, setting.value); },
  getSyncOperationsForPrincipal: async () => store.operations,
}));

import { ScanPage } from "../field-app/src/pages/ScanPage";

const visitId = "c2ec1beb-d191-4923-80b3-b1d3a8d58fad";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.settings.clear();
  store.operations = [];
  store.server = { status: "open", report_sent: false, inspection_ids: ["insp-1"] };
  store.settings.set("selected-facility:u:org", "facility-1");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function openVisit() {
  store.settings.set(`inspection-visit:${visitId}`, {
    id: visitId, organizationId: "org", userId: "u", facilityId: "facility-1", status: "open",
    inspections: [
      { inspectionId: "insp-1", openingId: "door-1", passed: true },
      { inspectionId: "insp-2", openingId: "door-2", passed: true },
      { inspectionId: "insp-3", openingId: "door-3", passed: false },
    ],
  });
  store.settings.set("inspection-visit-open:u:org:facility-1", visitId);
}

it("hides a visit the server already finished and keeps the local inspections", async () => {
  openVisit();
  store.server = { status: "finished", report_sent: true, inspection_ids: ["insp-1", "insp-2"] };
  store.operations = [{ entityId: "insp-3", entityType: "inspection_event", state: "queued" }];
  await act(async () => root.render(<MemoryRouter><ScanPage /></MemoryRouter>));
  await act(async () => {});
  expect(host.textContent).not.toContain("This visit: 3 openings");
  expect((store.settings.get(`inspection-visit:${visitId}`) as { inspections: unknown[]; status: string }).inspections).toHaveLength(3);
  expect((store.settings.get(`inspection-visit:${visitId}`) as { status: string }).status).toBe("finished");
  expect(store.settings.get("inspection-visit-open:u:org:facility-1")).toBe("");
  expect(store.operations).toHaveLength(1);
});

it("leaves the visit band when the server cannot be checked", async () => {
  openVisit();
  store.server = null;
  await act(async () => root.render(<MemoryRouter><ScanPage /></MemoryRouter>));
  await act(async () => {});
  expect(host.textContent).toContain("This visit: 3 openings");
  expect(store.settings.get("inspection-visit-open:u:org:facility-1")).toBe(visitId);
});

it("starts a new visit without dropping an inspection that is not on the server", async () => {
  openVisit();
  store.server = { status: "open", report_sent: false, inspection_ids: ["insp-1"] };
  store.operations = [{ entityId: "insp-3", entityType: "inspection_event", state: "queued" }];
  await act(async () => root.render(<MemoryRouter><ScanPage /></MemoryRouter>));
  await act(async () => {});
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Start a new visit");
  await act(async () => button!.click());
  expect(host.textContent).toContain("2 inspection(s) are still uploading, try again");
  expect(host.textContent).toContain("were not removed");
  expect(host.textContent).not.toContain("This visit: 3 openings");
  expect(store.operations).toHaveLength(1);
  expect(store.settings.get("inspection-visit-open:u:org:facility-1")).not.toBe(visitId);
  expect((store.settings.get(`inspection-visit:${visitId}`) as { inspections: unknown[] }).inspections).toHaveLength(3);
});
