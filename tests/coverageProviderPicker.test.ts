// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "../dashboard/node_modules/react";
import { createRoot } from "../dashboard/node_modules/react-dom/client";

const providerId = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({
  assignProvider: vi.fn(),
  fetchCoverage: vi.fn(),
  listCounties: vi.fn(),
  listStates: vi.fn(),
  saveFacilityCounty: vi.fn(),
  addBranchArea: vi.fn(),
  addTechnicianArea: vi.fn(),
  providerRequestOptions: vi.fn(),
}));
vi.mock("../dashboard/src/lib/api", () => ({
  assignProvider: state.assignProvider,
  fetchCoverage: state.fetchCoverage,
  listCounties: state.listCounties,
  listStates: state.listStates,
  saveFacilityCounty: state.saveFacilityCounty,
  addBranchArea: state.addBranchArea,
  addTechnicianArea: state.addTechnicianArea,
  providerRequestOptions: state.providerRequestOptions,
}));
vi.mock("../dashboard/src/components/Sidebar", () => ({ Sidebar: () => null }));
import { CoveragePage } from "../dashboard/src/pages/CoveragePage";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.listStates.mockResolvedValue([{ code: "AZ", name: "Arizona" }]);
  state.listCounties.mockResolvedValue([]);
  state.fetchCoverage.mockResolvedValue({
    facilities: [{ id: "fac-1", name: "Ridge" }],
    branches: [],
    technicians: [],
    assignments: [],
  });
  state.providerRequestOptions.mockResolvedValue({
    providers: [{ id: providerId, name: "Acme Doors" }],
    assigned: [],
  });
  state.assignProvider.mockResolvedValue({});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function providerSelect() {
  return host.querySelector('select[aria-label="Provider"]') as HTMLSelectElement;
}

it("assigns the provider chosen by name and keeps the out-of-area message", async () => {
  await act(async () => root.render(createElement(CoveragePage)));
  await vi.waitFor(() => expect(providerSelect().textContent).toContain("Acme Doors"));
  expect(host.querySelector('input[aria-label="Provider company id"]')).toBeNull();
  expect(providerSelect().textContent).not.toContain(providerId);
  const facility = host.querySelector('select[aria-label="Facility"]') as HTMLSelectElement;
  await act(async () => {
    facility.value = "fac-1";
    facility.dispatchEvent(new Event("change", { bubbles: true }));
    providerSelect().value = providerId;
    providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
  });
  const form = [...host.querySelectorAll("form")].find((f) => f.contains(providerSelect()))!;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(state.assignProvider).toHaveBeenCalledWith("fac-1", providerId, true));

  state.assignProvider.mockRejectedValueOnce(Object.assign(new Error("out_of_area"), { message: "out_of_area" }));
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(host.textContent).toContain("That provider does not cover this facility's state and county."));
});

it("shows an empty provider list when eligible providers cannot be loaded", async () => {
  state.providerRequestOptions.mockRejectedValue(Object.assign(new Error("facility_admin_required"), { status: 403 }));
  await act(async () => root.render(createElement(CoveragePage)));
  await vi.waitFor(() => expect(host.textContent).toContain("No eligible providers."));
  expect([...providerSelect().options].map((o) => o.value)).toEqual([""]);
  expect(host.querySelector('input[aria-label="Provider company id"]')).toBeNull();
});
