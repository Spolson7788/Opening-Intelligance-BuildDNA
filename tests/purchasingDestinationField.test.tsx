// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  destination: vi.fn(),
  docs: vi.fn(async () => []),
  send: vi.fn(),
}));
vi.mock("../field-app/src/lib/api", () => ({
  purchasingDestination: (...args: unknown[]) => api.destination(...args),
  listOpeningDocuments: (...args: unknown[]) => api.docs(...args),
  sendHardwareToPurchasing: (...args: unknown[]) => api.send(...args),
}));
vi.mock("../field-app/src/lib/photoPreparation", () => ({ checklistPhotoJpeg: async (file: Blob) => file }));

import { SendToPurchasing } from "../field-app/src/components/SendToPurchasing";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows the branch and recipient, and asks for a choice when more than one branch covers the job", async () => {
  api.destination.mockResolvedValueOnce({
    ready: false,
    error: "branch_choice_required",
    choices: [{ id: "west", name: "West" }, { id: "east", name: "East" }],
  });
  await act(async () => root.render(<SendToPurchasing openingId="opening" hardwareId="hardware" principal={{}} />));
  await act(async () => {});
  expect(host.textContent).toContain("More than one branch covers this job");
  expect(host.querySelector("#purchasing-branch")).toBeTruthy();
  expect((host.querySelector("button.btn-primary") as HTMLButtonElement).disabled).toBe(true);

  api.destination.mockResolvedValueOnce({ ready: true, to: "west@example.com", source: "branch", branch: { id: "west", name: "West" } });
  await act(async () => {
    const select = host.querySelector("#purchasing-branch") as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(select, "west");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {});
  expect(host.textContent).toContain("West: west@example.com");
  expect((host.querySelector("button.btn-primary") as HTMLButtonElement).disabled).toBe(false);
});
