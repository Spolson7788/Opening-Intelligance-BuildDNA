import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { userId: "tech", organizationId: "org-a", role: "technician", email: "tech@example.invalid" } as any,
  facilities: [] as any[],
  settings: new Map<string, any>(),
  logout: vi.fn(),
  selected: [] as string[],
}));
vi.mock("../field-app/src/lib/AuthContext", () => ({ useAuth: () => ({ auth: state.auth, logout: state.logout, logoutPending: false }) }));
vi.mock("../field-app/src/lib/api", () => ({ listFieldProperties: async () => state.facilities }));
vi.mock("../field-app/src/lib/db", () => ({
  getOfflineSetting: async (key: string) => state.settings.has(key) ? { key, value: state.settings.get(key) } : undefined,
  putOfflineSetting: async (setting: { key: string; value: unknown }) => { state.settings.set(setting.key, setting.value); },
}));
vi.mock("../field-app/src/components/FacilitySelector", () => ({ useFacilitySync: () => ({ select: (id: string) => { state.selected.push(id); } }) }));
import { ChooseLocationPage } from "../field-app/src/pages/ChooseLocationPage";

const facilities = [
  { id: "a", name: "Alpha", state_code: "CA", state_name: "California", county_fips: "037", county_name: "Los Angeles" },
  { id: "b", name: "Beta", state_code: "CA", state_name: "California", county_fips: "073", county_name: "San Diego" },
  { id: "c", name: "Gamma", state_code: "NV", state_name: "Nevada", county_fips: "003", county_name: "Clark" },
  { id: "d", name: "Delta", state_code: null, state_name: null, county_fips: null, county_name: null },
];
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  state.facilities = facilities;
  state.settings = new Map();
  state.selected = [];
  state.auth = { userId: "tech", organizationId: "org-a", role: "technician", email: "tech@example.invalid" };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MemoryRouter><ChooseLocationPage /></MemoryRouter>));
const select = (id: string) => host.querySelector(id) as HTMLSelectElement;
async function choose(id: string, value: string) {
  const element = select(id);
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text) as HTMLButtonElement;

it("requires Continue when several facilities are authorized and shows a missing state", async () => {
  await render();
  expect(button("Continue").disabled).toBe(true);
  expect(host.textContent).toContain("State not set");
  await choose("#location-state", "CA");
  expect(select("#location-county").value).toBe("");
  expect(button("Continue").disabled).toBe(true);
  await choose("#location-county", "037");
  expect(select("#location-facility").value).toBe("a");
  expect(host.textContent).toContain("Selected location: Alpha — California, Los Angeles");
  await act(async () => button("Continue").click());
  expect(state.selected).toEqual(["a"]);
  expect(sessionStorage.getItem("location-confirmed:tech:org-a")).toBe("a");
  expect(sessionStorage.getItem("location-confirmed:tech:org-b")).toBeNull();
});

it("auto-selects the only facility and still requires Continue", async () => {
  state.facilities = [facilities[0]];
  await render();
  expect(select("#location-state").value).toBe("CA");
  expect(select("#location-facility").value).toBe("a");
  expect(button("Continue").disabled).toBe(false);
  expect(host.textContent).toContain("Alpha — California, Los Angeles");
});

it("does not offer Scan when the account has no facilities", async () => {
  state.facilities = [];
  await render();
  expect(host.textContent).toContain("No facilities are assigned");
  expect(host.textContent).toContain("Scan does not open");
  expect(button("Continue")).toBeUndefined();
  expect(host.querySelector('a[href="/setup-opening"]')).toBeNull();
});

it("asks a returning account to confirm the last location and can change it", async () => {
  state.settings.set("selected-facility:tech:org-a", "c");
  await render();
  expect(host.textContent).toContain("Last location");
  expect(host.textContent).toContain("Gamma — Nevada, Clark");
  await act(async () => button("Change location").click());
  await choose("#location-state", "__unset__");
  expect(select("#location-county").value).toBe("__unset__");
  expect(select("#location-facility").value).toBe("d");
  expect(host.textContent).toContain("Delta — State not set, County not set");
});
