// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "../dashboard/node_modules/react";
import { createRoot } from "../dashboard/node_modules/react-dom/client";
import { MemoryRouter } from "../dashboard/node_modules/react-router-dom/dist/index.mjs";

const api = vi.hoisted(() => ({
  listOpenings: vi.fn(),
  listProperties: vi.fn(),
  listCompanies: vi.fn(),
  downloadOpeningsCsv: vi.fn(),
  downloadComplianceReport: vi.fn(),
  fetchCapitalForecastRollup: vi.fn(),
  fetchComplianceAlerts: vi.fn(),
  platformMe: vi.fn(),
}));
vi.mock("../dashboard/src/lib/api", () => api);
vi.mock("../dashboard/src/lib/AuthContext", () => ({
  useAuth: () => ({ auth: { role: "admin", userId: "u", organizationId: "org-1" }, logout: () => {} }),
}));
vi.mock("../dashboard/src/lib/LocationContext", () => ({
  useLocations: () => ({
    combined: false,
    index: { canExportTree: true },
    inFilter: () => true,
    label: () => "Acme / Main",
    setFilter: () => {},
  }),
}));
vi.mock("../dashboard/src/components/LocationBar", () => ({
  LocationBar: () => null,
  useCreateTarget: () => ({ mustChoose: false, targets: [], choose: async () => true }),
  CreateLocationPicker: () => null,
}));
import { DashboardPage } from "../dashboard/src/pages/DashboardPage";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.listProperties.mockResolvedValue([{
    id: "p1", name: "Main", city: "Phoenix", state: "AZ", state_code: "AZ", state_name: "Arizona", county_name: "Maricopa County", county_fips: "04013",
    buildings: [{ id: "b1", name: "North" }],
  }]);
  api.listOpenings.mockResolvedValue([
    { id: "o1", opening_code: "A-1", building_id: "b1", floor_label: "1", location_description: "Lobby", opening_type: "door", fire_rated: true, life_safety_critical: false, is_electrified: false, health_score: 80, status: "active", opening_configuration: "single", completion_state: "complete" },
    { id: "o2", opening_code: "A-2", building_id: "b1", floor_label: null, location_description: null, opening_type: "door", fire_rated: false, life_safety_critical: false, is_electrified: false, health_score: 30, status: "active", opening_configuration: "single", completion_state: "complete" },
  ]);
  api.listCompanies.mockResolvedValue([{ organization_id: "org-1", name: "Acme Doors", role: "admin", is_home: true }]);
  api.fetchCapitalForecastRollup.mockResolvedValue({ properties: [{ property_id: "p1", property_name: "Main", total_openings: 2, buckets: { urgent: { label: "Urgent", total: 1, by_type: {}, needing_estimate_by_type: { door: 1 }, known_cost_total: 400 } } }] });
  api.fetchComplianceAlerts.mockResolvedValue({ total_flagged: 1, counts: { never_inspected: 1, overdue: 0, due_soon: 0 }, alerts: [{ id: "c1", opening_code: "A-2", floor_label: null, location_description: null, fire_rated: false, life_safety_critical: true, building_name: "North", property_name: "Main", property_id: "p1", last_inspection_date: null, alert_level: "never_inspected" }] });
  api.platformMe.mockResolvedValue({ staff: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it("renders the overview from API data and leaves service cost unavailable", async () => {
  const css = readFileSync("dashboard/src/index.css", "utf8");
  expect(css).toMatch(/\.sidebar\s*\{[^}]*min-height:\s*100vh/);
  expect(css).toMatch(/\.ov-new-panel\s*\{[^}]*position:\s*static/);
  await act(async () => {
    root.render(createElement(MemoryRouter, { basename: "/dashboard/", initialEntries: ["/dashboard/"] }, createElement(DashboardPage)));
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Maricopa County"));
  expect(host.textContent).not.toMatch(/Example data/i);
  expect(host.textContent).toContain("Portfolio Health Score");
  expect(host.textContent).toContain("Openings on File");
  expect(host.textContent).toContain("Need Attention");
  expect(host.textContent).toContain("Fire-Rated Openings");
  expect(host.textContent).toContain("Identified Corrective Work");
  expect(host.textContent).toContain("$400");
  expect(host.textContent).toContain("Recorded Service This Quarter");
  expect(host.textContent).toContain("Not available");
  expect(host.textContent).toContain("Condition at a glance");
  expect(host.textContent).toContain("Service & compliance");
  expect(host.textContent).toContain("1 compliance alert on file.");
  expect(host.textContent).toContain("Export CSV");
  expect(host.textContent).toContain("Compliance Report (PDF)");
  expect(host.textContent).toContain("Group by state and county");
  const menu = host.querySelector("button[aria-controls='new-menu-panel']") as HTMLButtonElement;
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  await act(async () => menu.click());
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  const panel = host.querySelector("#new-menu-panel") as HTMLElement;
  expect(panel.textContent).toContain("New Property");
  expect(panel.textContent).toContain("New Opening");
  expect(getComputedStyle(panel).position).not.toBe("absolute");
});
