// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeInspectDraft } from "../field-app/src/lib/inspectionDraft";
import { techTasksEnabled } from "../field-app/src/lib/techTasks";

const auth = vi.hoisted(() => ({ role: "technician" }));
const settings = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
const calls = vi.hoisted(() => ({
  queue: vi.fn(async () => "saved-1"),
  email: vi.fn(async () => ({ sent: true, delivery_mode: "attachments" })),
  pdf: vi.fn(async () => ({ stored: true, reused: false, bytes: 10 })),
  route: null as null | { stops: unknown[] },
  hardware: [] as { id: string; component_type?: string; manufacturer?: string; model_number?: string }[],
  properties: [] as { id: string; name: string; buildings?: { id: string; name: string }[] }[],
  openings: [] as { id: string; opening_code: string; location_description?: string }[],
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
  fetchOpening: vi.fn(async () => ({ opening: { opening_code: "510A", inspection_events: [{ passed: true, created_at: "2026-11-12T19:30:23.000Z" }], hardware_components: calls.hardware } })),
  listFieldProperties: vi.fn(async () => calls.properties),
  listOpenings: vi.fn(async () => calls.openings),
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
  getOfflineSetting: async (key: string) => settings.values.has(key) ? { key, value: settings.values.get(key), updatedAt: "" } : undefined,
  putOfflineSetting: async (setting: { key: string; value: unknown }) => { settings.values.set(setting.key, setting.value); },
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
import { SiteDoorsPage } from "../field-app/src/pages/SiteDoorsPage";
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
  calls.hardware = [];
  calls.properties = [];
  calls.openings = [];
  calls.visit = { status: "open", report_sent: false, doors: [] };
  settings.values.clear();
  settings.values.set("selected-facility:u:org", "facility-1");
  settings.values.set("inspection-visit-open:u:org:facility-1", "visit-1");
  settings.values.set("inspection-visit:visit-1", { id: "visit-1", organizationId: "org", userId: "u", facilityId: "facility-1", status: "open", inspections: [] });
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

it("shows only the route on Start my day", async () => {
  calls.route = { stops: [
    { id: "s1", property_id: "facility-1", property_name: "SYNTHETIC Facility A", opening_code: "510A", time_window: "8:00", done: true, navigation_address: "1 Main", latitude: null, longitude: null, maps: { apple: "https://maps.apple.com", google: "https://maps.google.com" } },
    { id: "s2", property_id: "facility-9", property_name: "SYNTHETIC Facility B", opening_code: "610A", time_window: "9:00", done: false, navigation_address: "2 Main", latitude: null, longitude: null, maps: { apple: "https://maps.apple.com", google: "https://maps.google.com" } },
  ] };
  await render(<StartMyDayPage />);
  await act(async () => {});
  expect(host.textContent).toContain("Start my day");
  expect(host.textContent).toContain("1 door · 1 done · 0 left");
  expect(host.textContent).toContain("1 door · 0 done · 1 left");
  expect(host.textContent).toContain("Open in Maps");
  expect(host.textContent).not.toContain("Inspect the next door");
  expect(host.textContent).not.toContain("Nearby work");
  expect(host.textContent).not.toContain("Finish the visit");
  expect(host.textContent).toContain("Current screens");
});

it("opens the site door list when a stop is tapped", async () => {
  calls.route = { stops: [
    { id: "s2", property_id: "facility-9", property_name: "SYNTHETIC Facility B", opening_code: "610A", time_window: "9:00", done: false, navigation_address: "2 Main", latitude: null, longitude: null, maps: { apple: "", google: "" } },
  ] };
  calls.properties = [{ id: "facility-9", name: "SYNTHETIC Facility B", buildings: [{ id: "b1", name: "Main" }] }];
  calls.openings = [{ id: "door-9", opening_code: "610A", location_description: "East" }];
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<StartMyDayPage />} />
          <Route path="/tasks/site" element={<SiteDoorsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {});
  const stop = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("SYNTHETIC Facility B"));
  await act(async () => { stop?.click(); });
  await act(async () => {});
  expect(host.textContent).toContain("610A");
  expect(host.textContent).toContain("Finish the visit");
  expect(host.textContent).toContain("Tap a door to inspect it.");
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
  expect(host.textContent).toContain("Scan this door's hardware");
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

it("hides the hardware scan when the door already has hardware", async () => {
  calls.hardware = [{ id: "hw-1", component_type: "closer", manufacturer: "LCN", model_number: "4040" }];
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/tasks/inspect/door-1"]}>
        <Routes><Route path="/tasks/inspect/:id" element={<InspectDoorPage />} /></Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {});
  expect(host.textContent).not.toContain("Scan this door's hardware");
  expect(host.textContent).toContain("Details");
});

it("saves a service note once and does not email it", async () => {
  calls.hardware = [{ id: "hw-1", component_type: "closer" }];
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
  await act(async () => {});
  expect(host.textContent).toContain("Photo the new part");
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
