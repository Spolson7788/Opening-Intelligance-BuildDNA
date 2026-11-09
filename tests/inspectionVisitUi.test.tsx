// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NFPA80_ITEMS } from "../field-app/src/lib/nfpa80Items";

const store = vi.hoisted(() => ({ settings: new Map<string, unknown>(), queued: vi.fn(async () => "insp-1") }));
vi.mock("../field-app/src/lib/sync", () => ({
  queueOpeningMutation: (...args: unknown[]) => store.queued(...args),
  flushOutbox: vi.fn(async () => {}),
  awaitInspectionSynced: vi.fn(async () => ({ ok: true })),
  onSyncStateChange: (cb: (state: { syncing: boolean }) => void) => { cb({ syncing: false }); return () => {}; },
}));
vi.mock("../field-app/src/lib/db", () => ({
  loadAuth: async () => ({ token: "t", userId: "u", organizationId: "org", role: "inspector" }),
  getOfflineSetting: async (key: string) => store.settings.has(key) ? { key, value: store.settings.get(key), updatedAt: "" } : undefined,
  putOfflineSetting: async (setting: { key: string; value: unknown }) => { store.settings.set(setting.key, setting.value); },
  removeUnconfirmedLocalPhoto: vi.fn(async () => true),
}));
vi.mock("../field-app/src/lib/api", () => ({
  recomputeHealthScore: vi.fn(async () => {}),
  inspectionReportRecipients: vi.fn(async () => ({ to: ["building@example.com", "signer@example.com"], facility_contact_email: "building@example.com", inspector_email: "signer@example.com" })),
  emailInspectionReport: vi.fn(),
  inspectionVisitRecipients: vi.fn(async () => ({ to: ["building@example.com", "signer@example.com"], facility_contact_email: "building@example.com", inspector_email: "signer@example.com" })),
  emailInspectionVisit: vi.fn(),
}));
vi.mock("../field-app/src/components/SyncBadge", () => ({ SyncBadge: () => <span>Sync</span> }));
vi.mock("../field-app/src/components/SignaturePad", () => ({
  SignaturePad: React.forwardRef((_props: unknown, ref: React.Ref<{ getDataUrl: () => string; clear: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ getDataUrl: () => "data:image/png;base64,abc", clear: () => {} }));
    return <canvas />;
  }),
}));

import { LogInspectionEventPage } from "../field-app/src/pages/LogInspectionEventPage";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.settings.clear();
  store.settings.set("selected-facility:u:org", "facility-1");
  store.queued.mockClear();
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
