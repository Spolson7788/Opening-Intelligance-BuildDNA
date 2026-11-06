// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "../dashboard/node_modules/react";
import { createRoot } from "../dashboard/node_modules/react-dom/client";
import { MemoryRouter } from "../dashboard/node_modules/react-router-dom/dist/index.mjs";

vi.mock("../dashboard/src/lib/AuthContext", () => ({
  useAuth: () => ({ auth: { role: "admin", userId: "u", organizationId: "o" }, logout: () => {} }),
}));
vi.mock("../dashboard/src/lib/api", () => ({
  platformMe: async () => ({ staff: true }),
}));
vi.mock("../dashboard/src/components/LocationBar", () => ({
  LocationBar: () => null,
  useCreateTarget: () => ({ mustChoose: false, targets: [], choose: async () => true }),
  CreateLocationPicker: () => null,
}));
import { Sidebar } from "../dashboard/src/components/Sidebar";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function link(name: string) {
  return [...host.querySelectorAll("a")].find((a) => a.textContent === name) as HTMLAnchorElement;
}

async function renderAt(path: string) {
  await act(async () => {
    root.render(createElement(MemoryRouter, { key: path, basename: "/dashboard/", initialEntries: [path] }, createElement(Sidebar)));
  });
  await vi.waitFor(() => expect(link("OI staff tools")).toBeTruthy());
}

it("links Portfolio Overview home under the dashboard basename and keeps the other sidebar links", async () => {
  const css = readFileSync("dashboard/src/index.css", "utf8");
  expect(css).toMatch(/\.sidebar-home:hover\s*\{[^}]*background:/);
  expect(css).toMatch(/\.sidebar-home\.active\s*\{[^}]*border-color:\s*var\(--accent\)/);
  expect(css).toMatch(/\.sidebar-home:focus-visible\s*\{[^}]*outline:/);

  await renderAt("/dashboard/");
  const home = link("Portfolio Overview");
  expect(home.tagName).toBe("A");
  expect(home.getAttribute("href")).toBe("/dashboard/");
  expect(home.className).toContain("sidebar-home");
  expect(home.className).toContain("active");
  expect(home.getAttribute("aria-current")).toBe("page");
  expect(home.tabIndex).toBeGreaterThanOrEqual(0);
  home.focus();
  expect(document.activeElement).toBe(home);

  expect(link("State and county").getAttribute("href")).toBe("/dashboard/coverage");
  expect(link("OI staff tools").getAttribute("href")).toBe("/dashboard/staff-tools");
  expect(link("Change password").getAttribute("href")).toBe("/dashboard/change-password");

  await renderAt("/dashboard/coverage");
  const away = link("Portfolio Overview");
  expect(away.getAttribute("href")).toBe("/dashboard/");
  expect(away.classList.contains("active")).toBe(false);
  expect(away.getAttribute("aria-current")).toBeNull();
  expect(link("State and county").className).not.toContain("sidebar-home");
});
