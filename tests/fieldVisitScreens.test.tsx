// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchInspectionVisit: vi.fn(),
  inspectionVisitRecipients: vi.fn(async () => ({ to: ["a@example.com"], facility_contact_email: null, inspector_email: "a@example.com" })),
  fetchOpening: vi.fn(),
  fetchOpenInspectionVisit: vi.fn(),
  listFieldProperties: vi.fn(),
  listOpenings: vi.fn(),
  serverFeatures: vi.fn(async () => ({ recognition: false })),
}));
vi.mock("../field-app/src/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  ...api,
  emailInspectionVisit: vi.fn(),
  emailInspectionReport: vi.fn(),
  inspectionReportRecipients: vi.fn(async () => ({ to: [], facility_contact_email: null, inspector_email: "" })),
  storeInspectionVisitPdf: vi.fn(),
  fetchOpeningByQr: vi.fn(),
  fetchOpeningByCode: vi.fn(),
  deletePhoto: vi.fn(),
  fetchPhotoAccessUrl: vi.fn(),
  fetchPhotoContent: vi.fn(),
}));
vi.mock("../field-app/src/lib/db", () => ({
  loadAuth: async () => ({ token: "t", userId: "u", organizationId: "org", role: "inspector" }),
  getSyncOperationsForPrincipal: async () => [],
  getOfflineSetting: async () => undefined,
  putOfflineSetting: async () => {},
  getAllOfflineMedia: async () => [],
  getAllSyncOperations: async () => [],
  getSyncOperationsForOpening: async () => [],
  saveMediaAndOperation: async () => {},
  updateCachedOpening: async () => {},
}));
vi.mock("../field-app/src/lib/sync", () => ({
  flushOutbox: async () => {},
  noteSyncDiagnostic: () => {},
  onSyncStateChange: () => () => {},
  queueOpeningMutation: vi.fn(),
  checksumBlob: async () => "checksum",
  dependencyIdsForOperation: () => [],
  getOrCreateDeviceId: async () => "device",
}));
vi.mock("../field-app/src/components/SyncBadge", () => ({ SyncBadge: () => <span>Sync</span> }));
vi.mock("../field-app/src/components/FacilitySelector", () => ({
  FacilitySelector: () => <p>Facilities</p>,
  useFacilitySync: () => ({ selectedId: "facility-1", properties: null }),
}));
vi.mock("../field-app/src/lib/AuthContext", () => ({
  useAuth: () => ({ auth: { userId: "u", organizationId: "org", role: "inspector" }, logout: () => {}, logoutPending: false, logoutError: null }),
}));

import { VisitReportPage } from "../field-app/src/pages/VisitReportPage";
import { FacilityOpeningsPage } from "../field-app/src/pages/FacilityOpeningsPage";
import { OpeningDetailPage } from "../field-app/src/pages/OpeningDetailPage";
import { InspectionDetailPage } from "../field-app/src/pages/InspectionDetailPage";
import { readFileSync } from "node:fs";
import { formatVisitDoorTime } from "../field-app/src/lib/inspectionVisit";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("lists each server opening in the visit and opens its inspection", async () => {
  api.fetchInspectionVisit.mockResolvedValue({
    inspected: 2,
    inspection_ids: ["insp-510", "insp-610"],
    doors: [
      { opening_id: "door-610", inspection_id: "insp-610", opening_code: "610A", opening_type: "single_swing", location: "West", passed: false, inspected_at: "2026-11-09T14:57:00.000Z" },
      { opening_id: "door-510", inspection_id: "insp-510", opening_code: "510A", opening_type: "pair", location: "East", passed: true, inspected_at: "2026-11-09T14:53:00.000Z" },
    ],
  });
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/visit/visit-1"]}>
      <Routes>
        <Route path="/visit/:id" element={<VisitReportPage />} />
        <Route path="/opening/:id/inspection/:eventId" element={<p>Inspection summary</p>} />
      </Routes>
    </MemoryRouter>,
  ));
  await act(async () => {});
  expect(host.textContent).toContain("This visit: 2 openings (1 passed, 1 failed)");
  expect(host.textContent).toContain("510A");
  expect(host.textContent).toContain("single swing");
  expect(host.textContent).toContain("pair");
  expect(host.querySelector(".c04-result-failed")?.textContent).toBe("Failed");
  expect(host.querySelector(".c04-result-passed")?.textContent).toBe("Passed");
  expect(formatVisitDoorTime("2026-11-12T19:30:23.000Z")).toBe("Nov 12, 12:30 PM");
  expect(host.textContent).toContain(formatVisitDoorTime("2026-11-09T14:57:00.000Z"));
  const failed = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("610A"));
  await act(async () => failed!.click());
  expect(host.textContent).toContain("Inspection summary");
});

it("marks openings inspected in the open visit without replacing the survey label", async () => {
  sessionStorage.setItem("oi-field-building", "building-1");
  api.listFieldProperties.mockResolvedValue([{ id: "facility-1", name: "Facility A", buildings: [{ id: "building-1", name: "Main" }] }]);
  api.listOpenings.mockResolvedValue([
    { id: "door-510", opening_code: "510A", schedule_door_mark: "510A", completion_state: "incomplete" },
    { id: "door-610", opening_code: "610A", schedule_door_mark: "610A", completion_state: "complete" },
  ]);
  api.fetchOpenInspectionVisit.mockResolvedValue({ id: "visit-1", inspections: [{ inspectionId: "insp-510", openingId: "door-510", passed: true }] });
  await act(async () => root.render(<MemoryRouter><FacilityOpeningsPage /></MemoryRouter>));
  await act(async () => {});
  const rows = [...host.querySelectorAll(".c04-opening")];
  const done = rows.find((row) => row.textContent?.includes("510A"));
  const other = rows.find((row) => row.textContent?.includes("610A"));
  expect(done?.textContent).toContain("Done With This Visit");
  expect(done?.textContent).toContain("to survey");
  expect(other?.textContent).not.toContain("Done With This Visit");
  expect(other?.textContent).toContain("complete");
});

it("uses an amber before-finishing note and the Scan toolbar on an opening", async () => {
  api.fetchOpening.mockResolvedValue({
    opening: {
      id: "door-1", opening_code: "510A", opening_type: "single_swing", opening_configuration: "single",
      location_description: "Corridor", floor_label: "1", health_score: null, fire_rated: true,
      photos: [], hardware_components: [], service_events: [], door_leaves: [], completion_state: "incomplete", frame: null,
    },
    fromCache: false,
  });
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/opening/door-1"]}>
      <Routes><Route path="/opening/:id" element={<OpeningDetailPage />} /></Routes>
    </MemoryRouter>,
  ));
  await act(async () => {});
  const note = host.querySelector(".c04-notice-amber");
  expect(note?.textContent).toContain("Before finishing:");
  expect(note?.className).not.toContain("error-text");
  expect(host.querySelector(".c04-toolbar .c04-back")?.textContent).toBe("Back");
  expect(host.querySelector(".top-bar")).toBeNull();
});

it("keeps the white header below the iPhone status bar", () => {
  const html = readFileSync("field-app/index.html", "utf8");
  const css = readFileSync("field-app/src/index.css", "utf8");
  expect(html).toContain("viewport-fit=cover");
  expect(css).toContain("padding-top: env(safe-area-inset-top)");
  expect(css).toMatch(/\.c04-header\s*\{[^}]*position:\s*sticky/s);
});

it("uses the Scan toolbar on the inspection summary", async () => {
  api.fetchOpening.mockResolvedValue({
    opening: {
      id: "door-1", opening_code: "610A",
      inspection_events: [{ id: "insp-610", event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", passed: false, checklist_result: { status: "complete", items: {} }, signed_by_name: "Ada" }],
    },
    fromCache: false,
  });
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/opening/door-1/inspection/insp-610"]}>
      <Routes><Route path="/opening/:id/inspection/:eventId" element={<InspectionDetailPage />} /></Routes>
    </MemoryRouter>,
  ));
  await act(async () => {});
  expect(host.textContent).toContain("Failed");
  expect(host.querySelector(".c04-toolbar .c04-back")?.textContent).toBe("Back");
  expect(host.querySelector(".top-bar")).toBeNull();
});
