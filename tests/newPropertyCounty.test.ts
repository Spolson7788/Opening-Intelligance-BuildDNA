// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "../dashboard/node_modules/react";
import { createRoot } from "../dashboard/node_modules/react-dom/client";
import { MemoryRouter } from "../dashboard/node_modules/react-router-dom/dist/index.mjs";

const state = vi.hoisted(() => ({
  listPortfolios: vi.fn(),
  createProperty: vi.fn(),
  createBuilding: vi.fn(),
  listStates: vi.fn(),
  listCounties: vi.fn(),
}));
vi.mock("../dashboard/src/lib/api", () => ({
  listPortfolios: state.listPortfolios,
  createProperty: state.createProperty,
  createBuilding: state.createBuilding,
  listStates: state.listStates,
  listCounties: state.listCounties,
}));
vi.mock("../dashboard/src/components/Sidebar", () => ({ Sidebar: () => null }));
import { NewPropertyPage } from "../dashboard/src/pages/NewPropertyPage";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.listPortfolios.mockResolvedValue([{ id: "pf-1", name: "Main Portfolio" }]);
  state.listStates.mockResolvedValue([{ code: "AZ", name: "Arizona" }, { code: "TX", name: "Texas" }]);
  state.listCounties.mockImplementation(async (code: string) => {
    if (code === "AZ") return [{ fips: "04013", state_code: "AZ", name: "Maricopa" }];
    if (code === "TX") return [{ fips: "48201", state_code: "TX", name: "Harris" }];
    return [];
  });
  state.createProperty.mockRejectedValueOnce(new Error("hold")).mockResolvedValue({ id: "prop-1", name: "Ridge" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function select(label: string) {
  return host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
}
async function choose(label: string, value: string) {
  await act(async () => {
    const el = select(label);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("loads counties for the chosen state and sends county_fips only when one is chosen", async () => {
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(NewPropertyPage))));
  await vi.waitFor(() => expect(select("Property state").textContent).toContain("Arizona"));
  await vi.waitFor(() => expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
  expect(select("Property county").required).toBe(false);
  expect([...select("Property county").options].map((o) => o.text)).toEqual(["County not set"]);

  await choose("Property state", "AZ");
  await vi.waitFor(() => expect(select("Property county").textContent).toContain("Maricopa"));
  expect(state.listCounties).toHaveBeenCalledWith("AZ");
  await choose("Property county", "04013");

  await choose("Property state", "TX");
  await vi.waitFor(() => expect(select("Property county").textContent).toContain("Harris"));
  expect(select("Property county").value).toBe("");
  expect(select("Property county").textContent).not.toContain("Maricopa");
  expect(state.listCounties).toHaveBeenCalledWith("TX");

  const name = host.querySelector("#name") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(name, "Ridge");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(state.createProperty).toHaveBeenCalledWith(expect.objectContaining({
    portfolio_id: "pf-1", name: "Ridge", state: "TX", state_code: "TX", county_fips: undefined,
  }));

  await choose("Property county", "48201");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(state.createProperty).toHaveBeenLastCalledWith(expect.objectContaining({
    state_code: "TX", county_fips: "48201",
  }));
});
