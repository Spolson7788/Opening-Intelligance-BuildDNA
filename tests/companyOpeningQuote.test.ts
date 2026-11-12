// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "../dashboard/node_modules/react";
import { createRoot } from "../dashboard/node_modules/react-dom/client";
import { MemoryRouter, Route, Routes } from "../dashboard/node_modules/react-router-dom/dist/index.mjs";

const api = vi.hoisted(() => ({
  fetchCompanyOpening: vi.fn(),
  listCompanies: vi.fn(),
  facilityDashboardAccess: vi.fn(),
  switchCompany: vi.fn(),
}));
vi.mock("../dashboard/src/lib/api", () => api);
vi.mock("../dashboard/src/lib/AuthContext", () => ({
  useAuth: () => ({ auth: { role: "admin", userId: "u", organizationId: "org-1" }, logout: () => {}, adoptToken: () => {} }),
}));
import { CompanyOpeningPage } from "../dashboard/src/pages/CompanyOpeningPage";
import { quoteStatus, siteTabFromQuery } from "../dashboard/src/pages/CompanySitePage";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

function opening(status: string | null) {
  return {
    id: "open-1",
    opening_code: "D-12",
    location_description: "Lobby",
    opening_type: "door",
    fire_rated: false,
    health_score: 80,
    needs_attention: false,
    building_name: "Main",
    property_id: "prop-1",
    property_name: "West yard",
    address: "West yard Street",
    kind: "small",
    kind_label: "Small account",
    customer_id: "prop-1",
    customer_name: "West yard",
    work_records: [],
    quotes: status ? [{ id: "q1", total_minor: 12500, approval_status: status }] : [],
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.listCompanies.mockResolvedValue([]);
  api.facilityDashboardAccess.mockRejectedValue(new Error("denied"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render() {
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ["/company/opening/open-1"] },
      createElement(Routes, null,
        createElement(Route, { path: "/company/opening/:id", element: createElement(CompanyOpeningPage) }),
      )));
  });
  await act(async () => { await Promise.resolve(); });
}

it("names the stored quote approval and points to Work and quotes", async () => {
  expect(quoteStatus("draft")).toBe("Draft");
  expect(quoteStatus("awaiting_approval")).toBe("Awaiting approval");
  expect(quoteStatus("approved")).toBe("Approved");
  expect(quoteStatus("declined")).toBe("Declined");
  expect(quoteStatus("anything-else")).toBe("Draft");
  expect(siteTabFromQuery("work")).toBe("work");
  expect(siteTabFromQuery("nope")).toBe("openings");
  api.fetchCompanyOpening.mockResolvedValue(opening("approved"));
  await render();
  expect(host.textContent).toContain("Approved");
  expect(host.textContent).not.toContain("not stored");
  const link = host.querySelector('a[href="/sites/prop-1?tab=work"]');
  expect(link?.textContent).toBe("Change it on the site's Work & quotes tab.");
});

it("does not invent a draft when the opening has no estimate", async () => {
  api.fetchCompanyOpening.mockResolvedValue(opening(null));
  await render();
  expect(host.textContent).toContain("No saved estimate.");
  expect(host.textContent).not.toContain("not stored");
  expect(host.querySelector('a[href="/sites/prop-1?tab=work"]')).toBeNull();
});
