import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../field-app/src/lib/api", () => ({ fetchOpening: vi.fn(), readMeasurementPhoto: vi.fn(), setOpeningConfiguration: vi.fn() }));
vi.mock("../field-app/src/lib/AuthContext", () => ({ useAuth: () => ({ auth: { userId: "user", organizationId: "org" } }) }));
vi.mock("../field-app/src/lib/sync", () => ({ queueOpeningMutation: vi.fn() }));
vi.mock("../field-app/src/lib/db", () => ({ updateCachedOpening: vi.fn(async () => undefined) }));

import { fetchOpening, readMeasurementPhoto } from "../field-app/src/lib/api";
import { queueOpeningMutation } from "../field-app/src/lib/sync";
import { OpeningStructurePage } from "../field-app/src/pages/OpeningStructurePage";

const opening = {
  id: "pair", opening_configuration: "pair",
  frame: { id: "frame", revision: 1, material: "Steel", condition: "good" },
  door_leaves: [
    { id: "active", leaf_role: "active", revision: 1, material: "A", condition: "good" },
    { id: "inactive", leaf_role: "inactive", revision: 1, material: "B", condition: "good" },
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lets a measurement photo come from the library and does not offer video", async () => {
  vi.mocked(fetchOpening).mockResolvedValue({ opening, fromCache: false });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/opening/pair/structure"]}>
      <Routes><Route path="/opening/:id/structure" element={<OpeningStructurePage />} /></Routes>
    </MemoryRouter>);
  });
  expect(host.textContent).toContain("Choose saved Measure screenshot");
  expect(host.textContent).toContain("Take photo");
  expect(host.textContent).not.toContain("Add photo to measurement photo");
  expect(host.textContent).not.toContain("Add video to measurement");
  const library = host.querySelector('input[aria-label="Choose saved Measure screenshot"]') as HTMLInputElement;
  const camera = host.querySelector('input[aria-label="Take photo"]') as HTMLInputElement;
  expect(library.accept).toContain("image/*");
  expect(library.hasAttribute("capture")).toBe(false);
  expect(camera.getAttribute("capture")).toBe("environment");
  const videos = [...host.querySelectorAll("input")].filter((input) => (input as HTMLInputElement).accept.includes("video"));
  expect(videos.map((input) => input.getAttribute("aria-label"))).toEqual([
    "Choose video for frame",
    "Choose video for door leaf",
    "Choose video for door leaf",
  ]);
  const framePhoto = host.querySelector('input[aria-label="Choose photo for frame"]') as HTMLInputElement;
  expect(framePhoto.getAttribute("capture")).toBe("environment");
});

async function readPair(suggestions: { field: string; inches: number; confidence: number; bounds: string }[]) {
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.mocked(fetchOpening).mockResolvedValue({ opening, fromCache: false });
  vi.mocked(readMeasurementPhoto).mockResolvedValue({ provider: "anthropic", written: false, suggestions });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/opening/pair/structure"]}>
      <Routes><Route path="/opening/:id/structure" element={<OpeningStructurePage />} /></Routes>
    </MemoryRouter>);
  });
  const input = host.querySelector('input[aria-label="Choose saved Measure screenshot"]') as HTMLInputElement;
  const file = new File(["jpeg"], "measure.jpg", { type: "image/jpeg" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const read = [...host.querySelectorAll("button")].find((button) => button.textContent === "Read measurements") as HTMLButtonElement;
  class ImmediateReader {
    result = "data:image/jpeg;base64,YQ==";
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    readAsDataURL() { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("FileReader", ImmediateReader);
  await act(async () => { read.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

it("saves edited measurement sizes together and leaves the button available", async () => {
  await readPair([
    { field: "frame_width", inches: 47, confidence: 0.95, bounds: "frame width: 3' 11\"" },
    { field: "frame_height", inches: 93, confidence: 0.95, bounds: "frame height: 7' 9\"" },
  ]);
  expect(host.textContent).toContain("Nothing was written yet.");
  const height = host.querySelector("#measure-value-id") as HTMLInputElement | null;
  const heightInput = [...host.querySelectorAll("input")].find((input) => (input as HTMLInputElement).value === "7' 9\"") as HTMLInputElement;
  expect(height).toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(heightInput, "8'");
    heightInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("96 in");
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save to Door & Frame") as HTMLButtonElement;
  await act(async () => { save.click(); });
  expect(queueOpeningMutation).toHaveBeenCalledWith("opening_frame", "pair", expect.objectContaining({
    id: "frame", expected_revision: 1, width_in: 47, height_in: 96,
  }), undefined, { userId: "user", organizationId: "org" });
  expect((host.querySelector("#frame-width") as HTMLInputElement).value).toBe("3' 11\"");
  expect((host.querySelector("#frame-height") as HTMLInputElement).value).toBe("8' 0\"");
  expect(host.textContent).toContain("Saved to Door & Frame: Frame width 3' 11\" (47 in), Frame height 8' 0\" (96 in), edited. Saved.");
  expect(host.querySelector("#measurement-saved")?.className).toContain("c04-band-green");
  expect(host.textContent).not.toContain("Save to Door & Frame");
  expect(host.querySelector("[id^='measure-value-']")).toBeNull();
  expect(host.textContent).toContain("Add a size");
});

it("queues an uneven pair offline and refuses a duplicate target", async () => {
  await readPair([
    { field: "active_width", inches: 36, confidence: 0.9, bounds: "active" },
    { field: "inactive_width", inches: 30, confidence: 0.9, bounds: "inactive" },
  ]);
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save to Door & Frame") as HTMLButtonElement;
  await act(async () => { save.click(); });
  expect(queueOpeningMutation).toHaveBeenCalledWith("door_leaf", "pair", expect.objectContaining({ id: "active", leaf_role: "active", width_in: 36, expected_revision: 1 }), undefined, expect.any(Object));
  expect(queueOpeningMutation).toHaveBeenCalledWith("door_leaf", "pair", expect.objectContaining({ id: "inactive", leaf_role: "inactive", width_in: 30, expected_revision: 1 }), undefined, expect.any(Object));
  expect(host.textContent).toContain("Waiting to sync.");
  expect(host.textContent).toContain("Uneven pair");
  expect(host.textContent).not.toContain("Save to Door & Frame");
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Add a size") as HTMLButtonElement;
  await act(async () => { add.click(); add.click(); });
  const selects = [...host.querySelectorAll("select")].filter((select) => (select as HTMLSelectElement).id.startsWith("measure-target")) as HTMLSelectElement[];
  expect(selects).toHaveLength(2);
  await act(async () => {
    for (const added of selects) {
      added.value = "active_width";
      added.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  const values = [...host.querySelectorAll("input")].filter((input) => (input as HTMLInputElement).id.startsWith("measure-value")) as HTMLInputElement[];
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    values.forEach((blank, index) => {
      setValue.call(blank, index === 0 ? "36" : "40");
      blank.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  vi.mocked(queueOpeningMutation).mockClear();
  const again = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save to Door & Frame") as HTMLButtonElement;
  await act(async () => { again.click(); });
  expect(queueOpeningMutation).not.toHaveBeenCalled();
  expect(host.textContent).toContain("more than once");
  expect(host.querySelectorAll("[id^='measure-value-']")).toHaveLength(2);
});

it("keeps the cards when a save fails and ignores a second tap while saving", async () => {
  await readPair([
    { field: "frame_width", inches: 47, confidence: 0.9, bounds: "width" },
  ]);
  let release: (value?: unknown) => void = () => {};
  vi.mocked(queueOpeningMutation).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save to Door & Frame") as HTMLButtonElement;
  await act(async () => { save.click(); save.click(); });
  expect(queueOpeningMutation).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  await act(async () => { release(); });
  expect(host.querySelector("[id^='measure-value-']")).toBeNull();
  vi.mocked(queueOpeningMutation).mockRejectedValueOnce(new Error("save_failed"));
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Add a size") as HTMLButtonElement;
  await act(async () => { add.click(); });
  const blank = host.querySelector("[id^='measure-value-']") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(blank, "40");
    blank.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save to Door & Frame") as HTMLButtonElement;
  await act(async () => { retry.click(); });
  expect(host.querySelector(".c04-step-alert")?.textContent).toContain("was not saved");
  expect(host.querySelector("[id^='measure-value-']")).not.toBeNull();
  expect((host.querySelector("[id^='measure-value-']") as HTMLInputElement).value).toBe("40");
});

it("shows a pending sync as a status when the earlier write is still queued", async () => {
  await readPair([
    { field: "frame_height", inches: 96, confidence: 0.9, bounds: "height" },
  ]);
  vi.mocked(queueOpeningMutation).mockRejectedValueOnce(new Error("structure_sync_pending_review"));
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save to Door & Frame") as HTMLButtonElement;
  await act(async () => { save.click(); });
  expect(host.querySelector(".c04-step-alert")).toBeNull();
  expect(host.textContent).toContain("already waiting to synchronize");
  expect(host.querySelector("[id^='measure-value-']")).not.toBeNull();
  expect(host.textContent).not.toContain("Return to the opening");
});
