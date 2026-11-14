// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeInspectDraft } from "../field-app/src/lib/inspectionDraft";
import { techTasksEnabled } from "../field-app/src/lib/techTasks";

const auth = vi.hoisted(() => ({ role: "technician" }));
const calls = vi.hoisted(() => ({
  queue: vi.fn(async () => "saved-1"),
  email: vi.fn(async () => ({ sent: true, delivery_mode: "attachments" })),
  pdf: vi.fn(async () => ({ stored: true, reused: false, bytes: 10 })),
  route: null as null | { stops: unknown[] },
  visit: { status: "open", report_sent: false, doors: [] as { opening_id: string; inspection_id: string; opening_code: string; passed: boolean; inspected_at: string }[] },
}));

vi.mock("../field-app/src/lib/AuthContext", () => ({
  useAuth: () => ({ auth: { userId: "u", organizationId: "org", role: auth.role, email: "tech@example.com" }, logout: vi.fn(), logoutPending: false }),
}));
vi.mock("../field-app/src/lib/sync", () => ({
  queueOpeningMutation: (...args: unknown[]) => calls.queue(...args),
  flushOutbox: vi.fn(async () => {}),
  noteSyncDiagnostic: () => {},
  awaitInspectionSynced: vi.fn(async () => ({ ok: true })),
  refreshPendingCount: vi.fn(async () => {}),
  onSyncStateChange: (cb: (state: { pending: number; failed: number; conflicts: number }) => void) => {
    cb({ pending: 0, failed: 0, conflicts: 0 });
    return () => {};
  },
}));
vi.mock("../field-app/src/lib/api", () => ({
  ApiError: class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
  fetchOpening: vi.fn(async () => ({ opening: { opening_code: "510A", inspection_events: [{ passed: true, created_at: "2026-11-12T19:30:23.000Z" }] } })),
  fetchOpeningByCode: vi.fn(),
  fetchCompanies: vi.fn(async () => ({ companies: [] })),
  fetchOpenInspectionVisit: vi.fn(async () => null),
  fetchInspectionVisit: vi.fn(async () => calls.visit),
  inspectionVisitRecipients: vi.fn(async () => ({ to: ["building@example.com"], facility_contact_email: "building@example.com", inspector_email: "tech@example.com" })),
  emailInspectionVisit: (...args: unknown[]) => calls.email(...args),
  storeInspectionVisitPdf: (...args: unknown[]) => calls.pdf(...args),
  recomputeHealthScore: vi.fn(),
}));
vi.mock("../field-app/src/lib/db", () => ({
  loadAuth: async () => ({ token: "t", userId: "u", organizationId: "org", role: auth.role }),
  getOfflineSetting: async (key: string) => {
    if (key === "selected-facility:u:org") return { key, value: "facility-1", updatedAt: "" };
    if (key === "inspection-visit-open:u:org:facility-1") return { key, value: "visit-1", updatedAt: "" };
    if (key === "inspection-visit:visit-1") return { key, value: { id: "visit-1", organizationId: "org", userId: "u", facilityId: "facility-1", status: "open", inspections: [] }, updatedAt: "" };
    return undefined;
  },
  putOfflineSetting: async () => {},
}));
vi.mock("../field-app/src/lib/fieldRoutes", () => ({
  fetchFieldRoute: async () => ({ route: calls.route, apple_maps: false }),
}));
vi.mock("../field-app/src/components/SignaturePad", () => ({
  SignaturePad: React.forwardRef((_props: unknown, ref: React.Ref<{ getDataUrl: () => string; clear: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ getDataUrl: () => "data:image/png;base64,abc", clear: () => {} }));
    return <canvas />;
  }),
}));

import { StartMyDayPage } from "../field-app/src/pages/StartMyDayPage";
import { InspectDoorPage } from "../field-app/src/pages/InspectDoorPage";
import { FixDoorPage } from "../field-app/src/pages/FixDoorPage";
import { FinishVisitPage } from "../field-app/src/pages/FinishVisitPage";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.role = "technician";
  calls.queue.mockClear();
  calls.email.mockClear();
  calls.pdf.mockClear();
  calls.route = null;
  calls.visit = { status: "open", report_sent: false, doors: [] };
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function render(node: React.ReactNode) {
  return act(async () => { root.render(<MemoryRouter>{node}</MemoryRouter>); });
}

it("keeps the task switch off unless the staging field build sets it", () => {
  expect(techTasksEnabled()).toBe(false);
  const staging = readFileSync("scripts/build-staging-package-16abbf4.mjs", "utf8");
  expect(staging).toContain("const tasks = app === 'field-app' ? { VITE_OI_TECH_TASKS: 'true' } : {}");
});

it("starts the day from the manager route and offers a site when there is no route", async () => {
  calls.route = { stops: [
    { id: "s1", property_name: "SYNTHETIC Facility A", opening_code: "510A", time_window: "8:00", done: true, navigation_address: "1 Main", latitude: null, longitude: null },
    { id: "s2", property_name: "SYNTHETIC Facility A", opening_code: "610A", time_window: "9:00", done: false, navigation_address: "1 Main", latitude: null, longitude: null },
    { id: "s3", property_name: "SYNTHETIC Facility A", opening_code: "710A", time_window: null, done: false, navigation_address: "1 Main", latitude: null, longitude: null },
  ] };
  await render(<StartMyDayPage />);
  await act(async () => {});
  expect(host.textContent).toContain("Start my day");
  expect(host.textContent).toContain("3 doors · 1 done · 2 left");
  expect(host.textContent).toContain("Open next stop in Maps");
  expect(host.textContent).toContain("Saved");
  expect(host.textContent).not.toContain("Facility Dashboard");
});

it("offers pick a site when the manager has no route", async () => {
  calls.route = null;
  await render(<StartMyDayPage />);
  await act(async () => {});
  expect(host.textContent).toContain("Pick a site");
  expect(host.textContent).not.toContain("Facility Dashboard");
});

it("keeps the checklist when the tech leaves to fix the door and comes back", async () => {
  writeInspectDraft("door-1", { labels: { result: "fail", note: "label missing" } });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/tasks/inspect/door-1"]}>
        <Routes>
          <Route path="/tasks/inspect/:id" element={<InspectDoorPage />} />
          <Route path="/tasks/fix/:id" element={<FixDoorPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {});
  const select = host.querySelector("[aria-label='labels']") as HTMLSelectElement;
  expect(select.value).toBe("fail");
  expect(host.textContent).toContain("Door 510A · last result Passed");
  const fix = [...host.querySelectorAll("a")].find((link) => link.textContent === "Fix this door");
  await act(async () => { fix?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await act(async () => {});
  expect(host.querySelector("h1")?.textContent).toBe("Fix this door");
  expect(host.textContent).toContain("Your checklist is still on this phone.");
  const back = [...host.querySelectorAll("button")].find((button) => button.textContent === "Back");
  await act(async () => { back?.click(); });
  await act(async () => {});
  expect((host.querySelector("[aria-label='labels']") as HTMLSelectElement).value).toBe("fail");
});

it("saves a service note once and does not email it", async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/tasks/fix/door-1"]}>
        <Routes>
          <Route path="/tasks/fix/:id" element={<FixDoorPage />} />
          <Route path="/tasks/inspect/:id" element={<p>Back on the inspection</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const note = host.querySelector("#work-done") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(note, "Adjusted the closer.");
    note.dispatchEvent(new Event("input", { bubbles: true }));
    note.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save");
  await act(async () => { save?.click(); });
  await act(async () => {});
  expect(calls.queue).toHaveBeenCalledTimes(1);
  expect(calls.queue.mock.calls[0][0]).toBe("service_event");
  expect(calls.email).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Back on the inspection");
});

it("lists the visit doors and sends one report only from the button", async () => {
  calls.visit = { status: "open", report_sent: false, doors: [
    { opening_id: "d1", inspection_id: "i1", opening_code: "510A", passed: true, inspected_at: "2026-11-12T19:30:23.000Z" },
  ] };
  await render(<FinishVisitPage />);
  await act(async () => {});
  expect(host.textContent).toContain("510A");
  expect(host.textContent).toContain("Nothing is emailed until you send.");
  expect(calls.email).not.toHaveBeenCalled();
  const send = [...host.querySelectorAll("button")].find((button) => button.textContent === "Send one report");
  await act(async () => { send?.click(); });
  await act(async () => {});
  expect(calls.email).toHaveBeenCalledTimes(1);
});

it("does not email a visit that is already finished", async () => {
  calls.visit = { status: "finished", report_sent: false, doors: [] };
  await render(<FinishVisitPage />);
  await act(async () => {});
  expect(host.textContent).toContain("No report was sent.");
  expect(calls.email).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Send one report");
});
