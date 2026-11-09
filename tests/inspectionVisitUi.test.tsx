// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NFPA80_ITEMS } from "../field-app/src/lib/nfpa80Items";

const store = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  queued: vi.fn(async () => "insp-1"),
  operations: [] as { entityId: string; entityType: string; state: string }[],
  serverIds: ["insp-210a", "insp-310a"],
  email: vi.fn(async () => ({ sent: true, delivery_mode: "attachments" })),
}));
vi.mock("../field-app/src/lib/sync", () => ({
  queueOpeningMutation: (...args: unknown[]) => store.queued(...args),
  flushOutbox: vi.fn(async () => {}),
  noteSyncDiagnostic: () => {},
  awaitInspectionSynced: vi.fn(async () => ({ ok: true })),
  onSyncStateChange: (cb: (state: { syncing: boolean }) => void) => { cb({ syncing: false }); return () => {}; },
}));
vi.mock("../field-app/src/lib/db", () => ({
  loadAuth: async () => ({ token: "t", userId: "u", organizationId: "org", role: "inspector" }),
  getOfflineSetting: async (key: string) => store.settings.has(key) ? { key, value: store.settings.get(key), updatedAt: "" } : undefined,
  putOfflineSetting: async (setting: { key: string; value: unknown }) => { store.settings.set(setting.key, setting.value); },
  removeUnconfirmedLocalPhoto: vi.fn(async () => true),
  getSyncOperationsForPrincipal: async () => store.operations,
}));
vi.mock("../field-app/src/lib/api", () => ({
  ApiError: class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
  recomputeHealthScore: vi.fn(async () => {}),
  inspectionReportRecipients: vi.fn(async () => ({ to: ["building@example.com", "signer@example.com"], facility_contact_email: "building@example.com", inspector_email: "signer@example.com" })),
  emailInspectionReport: vi.fn(),
  inspectionVisitRecipients: vi.fn(async () => ({ to: ["building@example.com", "signer@example.com"], facility_contact_email: "building@example.com", inspector_email: "signer@example.com" })),
  fetchInspectionVisit: vi.fn(async () => ({ inspected: store.serverIds.length, inspection_ids: store.serverIds })),
  emailInspectionVisit: (...args: unknown[]) => store.email(...args),
  storeInspectionVisitPdf: vi.fn(async () => ({ stored: true, reused: false, bytes: 1200 })),
}));
vi.mock("../field-app/src/components/SyncBadge", () => ({ SyncBadge: () => <span>Sync</span> }));
vi.mock("../field-app/src/components/SignaturePad", () => ({
  SignaturePad: React.forwardRef((_props: unknown, ref: React.Ref<{ getDataUrl: () => string; clear: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ getDataUrl: () => "data:image/png;base64,abc", clear: () => {} }));
    return <canvas />;
  }),
}));

import { LogInspectionEventPage } from "../field-app/src/pages/LogInspectionEventPage";
import { VisitReportPage } from "../field-app/src/pages/VisitReportPage";
import { flushOutbox } from "../field-app/src/lib/sync";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.settings.clear();
  store.settings.set("selected-facility:u:org", "facility-1");
  store.operations = [];
  store.serverIds = ["insp-210a", "insp-310a"];
  store.email.mockClear();
  store.queued.mockClear();
  vi.mocked(flushOutbox).mockClear();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function saveFireDoor() {
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/opening/door-1/log-inspection"]}>
      <Routes>
        <Route path="/opening/:id/log-inspection" element={<LogInspectionEventPage />} />
        <Route path="/scan" element={<p>Scan opening</p>} />
        <Route path="/choose-location" element={<p>Choose location</p>} />
      </Routes>
    </MemoryRouter>,
  ));
  const select = host.querySelector("#inspection-type") as HTMLSelectElement;
  const setInput = (selector: string, value: string) => {
    const input = host.querySelector(selector) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(select, "fire_door_nfpa80");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    setInput("#qualification", "Fire door inspector");
    setInput("#license-number", "FD-100");
    setInput("#signed-by-name", "Ada Inspector");
    for (const item of NFPA80_ITEMS) {
      const answer = host.querySelector(`[aria-label="${item.key}"]`) as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(answer, "pass");
      answer.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("keeps the facility and adds one inspection when save is tapped twice", async () => {
  await saveFireDoor();
  expect(store.queued).toHaveBeenCalledTimes(1);
  const payload = store.queued.mock.calls[0][2] as { visit_id?: string };
  expect(payload.visit_id).toBeTruthy();
  const visit = store.settings.get(`inspection-visit:${payload.visit_id}`) as { facilityId: string; inspections: unknown[] };
  expect(visit.facilityId).toBe("facility-1");
  expect(visit.inspections).toHaveLength(1);
  expect(host.textContent).toContain("This visit: 1 openings (1 passed, 0 failed)");
  expect(host.textContent).toContain("Add an Additional Opening");
  expect(host.textContent).toContain("Email this report");
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Add an Additional Opening");
  await act(async () => add!.click());
  expect(host.textContent).toContain("Scan opening");
  expect(host.textContent).not.toContain("Choose location");
});

it("does not send the combined report while 310A is still off the server", async () => {
  const visitId = "visit-race";
  store.serverIds = ["insp-210a"];
  store.settings.set(`inspection-visit:${visitId}`, {
    id: visitId, organizationId: "org", userId: "u", facilityId: "facility-1", status: "open",
    inspections: [
      { inspectionId: "insp-210a", openingId: "door-210a", passed: true },
      { inspectionId: "insp-310a", openingId: "door-310a", passed: false },
    ],
  });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/visit/${visitId}`]}>
      <Routes><Route path="/visit/:id" element={<VisitReportPage />} /></Routes>
    </MemoryRouter>,
  ));
  expect(host.textContent).toContain("On this device: 2. On the server: 1.");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(flushOutbox).toHaveBeenCalled();
  expect(store.email).not.toHaveBeenCalled();
  expect(host.textContent).toContain("1 inspection(s) are still uploading, try again");
});

it("clears the active visit after the combined report is sent", async () => {
  const visitId = "visit-sent";
  store.serverIds = ["insp-210a"];
  store.settings.set(`inspection-visit:${visitId}`, {
    id: visitId, organizationId: "org", userId: "u", facilityId: "facility-1", status: "open",
    inspections: [{ inspectionId: "insp-210a", openingId: "door-210a", passed: true }],
  });
  store.settings.set("inspection-visit-open:u:org:facility-1", visitId);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/visit/${visitId}`]}>
      <Routes><Route path="/visit/:id" element={<VisitReportPage />} /></Routes>
    </MemoryRouter>,
  ));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(store.email).toHaveBeenCalledWith("visit-sent", ["building@example.com", "signer@example.com"], ["insp-210a"]);
  expect((store.settings.get(`inspection-visit:${visitId}`) as { status: string }).status).toBe("finished");
  expect(store.settings.get("inspection-visit-open:u:org:facility-1")).toBe("");
});

it("shows the HTTP status when sending the report fails and leaves the visit open", async () => {
  const { storeInspectionVisitPdf, ApiError } = await import("../field-app/src/lib/api");
  const visitId = "visit-timeout";
  store.serverIds = ["insp-210a"];
  store.settings.set(`inspection-visit:${visitId}`, {
    id: visitId, organizationId: "org", userId: "u", facilityId: "facility-1", status: "open",
    inspections: [{ inspectionId: "insp-210a", openingId: "door-210a", passed: false }],
  });
  store.settings.set("inspection-visit-open:u:org:facility-1", visitId);
  vi.mocked(storeInspectionVisitPdf).mockRejectedValueOnce(new ApiError(504, "unexpected_response"));
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/visit/${visitId}`]}>
      <Routes><Route path="/visit/:id" element={<VisitReportPage />} /></Routes>
    </MemoryRouter>,
  ));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Could not email the report (504: unexpected_response)");
  expect(host.textContent).toContain("The visit stays open");
  expect(store.email).not.toHaveBeenCalled();
  expect((store.settings.get(`inspection-visit:${visitId}`) as { status: string }).status).toBe("open");
});
