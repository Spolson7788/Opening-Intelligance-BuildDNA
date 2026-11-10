import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../field-app/src/lib/api", () => ({ fetchOpening: vi.fn(), readMeasurementPhoto: vi.fn(), setOpeningConfiguration: vi.fn() }));
vi.mock("../field-app/src/lib/AuthContext", () => ({ useAuth: () => ({ auth: { userId: "user", organizationId: "org" } }) }));
vi.mock("../field-app/src/lib/sync", () => ({ queueOpeningMutation: vi.fn() }));
vi.mock("../field-app/src/lib/db", () => ({ updateCachedOpening: vi.fn() }));

import { fetchOpening } from "../field-app/src/lib/api";
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
