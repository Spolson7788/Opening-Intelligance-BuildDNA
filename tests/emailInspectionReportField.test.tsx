// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emailFailureText } from "../field-app/src/components/EmailInspectionReport";
import { NFPA80_ITEMS } from "../field-app/src/lib/nfpa80Items";

const api = vi.hoisted(() => ({
  recipients: vi.fn(),
  send: vi.fn(),
  recompute: vi.fn(),
  fetchOpening: vi.fn(),
}));
vi.mock("../field-app/src/lib/api", () => ({
  inspectionReportRecipients: (...args: unknown[]) => api.recipients(...args),
  emailInspectionReport: (...args: unknown[]) => api.send(...args),
  recomputeHealthScore: (...args: unknown[]) => api.recompute(...args),
  fetchOpening: (...args: unknown[]) => api.fetchOpening(...args),
  fetchOpeningByQr: (...args: unknown[]) => api.fetchOpening(...args),
  fetchOpeningByCode: (...args: unknown[]) => api.fetchOpening(...args),
  deletePhoto: vi.fn(),
  fetchPhotoAccessUrl: vi.fn(),
  serverFeatures: vi.fn(async () => ({ recognition: false })),
}));
vi.mock("../field-app/src/lib/sync", () => ({
  queueOpeningMutation: vi.fn(async () => "insp-1"),
  flushOutbox: vi.fn(async () => {}),
  awaitInspectionSynced: vi.fn(async () => ({ ok: true })),
  onSyncStateChange: (cb: (state: { syncing: boolean }) => void) => { cb({ syncing: false }); return () => {}; },
}));
vi.mock("../field-app/src/lib/db", () => ({
  getAllOfflineMedia: async () => [],
  getSyncOperationsForOpening: async () => [],
  loadAuth: async () => null,
  updateCachedOpening: vi.fn(),
}));
vi.mock("../field-app/src/components/SyncBadge", () => ({ SyncBadge: () => <span>Sync</span> }));
vi.mock("../field-app/src/components/PhotoCapture", () => ({ PhotoCapture: () => null }));
vi.mock("../field-app/src/components/SignaturePad", () => ({
  SignaturePad: React.forwardRef((_props: unknown, ref: React.Ref<{ getDataUrl: () => string; clear: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ getDataUrl: () => "data:image/png;base64,abc", clear: () => {} }));
    return <canvas />;
  }),
}));

import { EmailInspectionReport } from "../field-app/src/components/EmailInspectionReport";
import { LogInspectionEventPage } from "../field-app/src/pages/LogInspectionEventPage";
import { OpeningDetailPage } from "../field-app/src/pages/OpeningDetailPage";
import { queueOpeningMutation } from "../field-app/src/lib/sync";
import { scrollPageToTop } from "../field-app/src/lib/scrollPage";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.recipients.mockReset().mockResolvedValue({ to: ["building@example.com", "signer@example.com"], facility_contact_email: "building@example.com", inspector_email: "signer@example.com" });
  api.send.mockReset().mockResolvedValue({ sent: true, delivery_mode: "attachments" });
  api.recompute.mockReset().mockResolvedValue(undefined);
  api.fetchOpening.mockReset();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("does not ask for recipients until the inspection has synced", async () => {
  await act(async () => root.render(<EmailInspectionReport inspectionId="local-1" syncStatus="syncing" />));
  expect(api.recipients).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Syncing… email will be available once synced");
});

it("scrolls the document to the top", () => {
  document.documentElement.scrollTop = 240;
  document.body.scrollTop = 240;
  scrollPageToTop();
  expect(document.documentElement.scrollTop).toBe(0);
  expect(document.body.scrollTop).toBe(0);
});

it("prefills the facility and signer, sends the edited list, and reports success or failure", async () => {
  await act(async () => root.render(<EmailInspectionReport inspectionId="insp-1" />));
  const box = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(box.value).toBe("building@example.com, signer@example.com");
  await act(async () => {
    box.value = "building@example.com, extra@example.com";
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(box, "building@example.com extra@example.com");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.send).toHaveBeenCalledWith("insp-1", ["building@example.com", "extra@example.com"]);
  expect(host.textContent).toContain("Report emailed.");

  api.send.mockRejectedValueOnce(new Error("nope"));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Could not email the report.");

  const configured = new Error("email_not_configured") as Error & { missing: string[] };
  configured.missing = ["EMAIL_FROM", "not a secret"];
  expect(emailFailureText(configured)).toBe("Email is not set up on this server. Missing EMAIL_FROM.");
  expect(emailFailureText(configured)).not.toContain("secret");
  expect(emailFailureText(new Error("email_send_failed"))).toBe("The email service rejected the report.");
});

it("does not queue an email while offline", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await act(async () => root.render(<EmailInspectionReport inspectionId="insp-1" />));
  expect(host.textContent).toContain("Emailing this report needs a connection.");
  expect(api.recipients).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
});

it("shows email this report after a signed fire door inspection is saved, and on the door history", async () => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/opening/door-1/log-inspection"]}>
      <Routes><Route path="/opening/:id/log-inspection" element={<LogInspectionEventPage />} /></Routes>
    </MemoryRouter>,
  ));
  const select = host.querySelector("#inspection-type") as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(select, "fire_door_nfpa80");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const setInput = (selector: string, value: string) => {
    const input = host.querySelector(selector) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
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
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await act(async () => {});
  expect(host.textContent).toContain("Saved.");
  expect(queueOpeningMutation).toHaveBeenCalledWith("inspection_event", "door-1", expect.objectContaining({
    inspection_type: "fire_door_nfpa80",
    checklist_result: expect.objectContaining({ status: "complete" }),
  }));
  expect(host.textContent).toContain("Email this report");
  expect(host.textContent).not.toContain("Returning to the opening");
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("building@example.com");

  await act(async () => root.unmount());
  root = createRoot(host);
  api.fetchOpening.mockResolvedValue({
    opening: {
      id: "door-1", opening_code: "D-1", opening_type: "door", photos: [], hardware_components: [],
      inspection_events: [
        { id: "insp-9", event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", passed: true, checklist_result: { status: "complete" } },
        { id: "insp-general", event_date: "2026-03-01", inspection_type: "general", passed: false },
      ],
      service_events: [], completion_state: "complete",
    },
    fromCache: false,
  });
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/opening/door-1"]}>
      <Routes><Route path="/opening/:id" element={<OpeningDetailPage />} /></Routes>
    </MemoryRouter>,
  ));
  const links = Array.from(host.querySelectorAll("a")).map((link) => link.getAttribute("href"));
  expect(links).toContain("/opening/door-1/inspection/insp-9");
  expect(links).toContain("/opening/door-1/inspection/insp-general");
});
