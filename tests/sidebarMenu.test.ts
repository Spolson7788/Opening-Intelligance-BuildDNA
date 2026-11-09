// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "../dashboard/node_modules/react";
import { createRoot } from "../dashboard/node_modules/react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "../dashboard/node_modules/react-router-dom/dist/index.mjs";
import { clickOpeningsExport, scrollToOpenings } from "../dashboard/src/lib/scrollToOpenings";

const auth = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../dashboard/src/lib/AuthContext", () => ({
  useAuth: () => ({ auth: { role: auth.role, userId: "u", organizationId: "o" }, logout: () => {} }),
}));
vi.mock("../dashboard/src/lib/api", () => ({ platformMe: async () => ({ staff: false }) }));
vi.mock("../dashboard/src/components/LocationBar", () => ({
  LocationBar: () => null,
  useCreateTarget: () => ({ mustChoose: false, targets: [], choose: async () => true }),
  CreateLocationPicker: () => null,
}));
import { Sidebar } from "../dashboard/src/components/Sidebar";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const exported = { n: 0 };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  auth.role = "admin";
  exported.n = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.getElementById("openings")?.remove();
  document.querySelector("[data-export-openings]")?.remove();
});

function Probe() {
  const location = useLocation();
  return createElement("p", { "data-probe": "1" }, `${location.pathname}${location.hash}`);
}
function Overview() {
  return createElement("div", null,
    createElement(Sidebar),
    createElement("section", { id: "openings", tabIndex: -1 },
      createElement("h2", null, "Openings"),
      createElement("button", { "data-export-openings": "", onClick: () => { exported.n += 1; } }, "Export CSV"),
    ),
  );
}
function Other({ title }: { title: string }) {
  return createElement("div", null, createElement(Sidebar), createElement("h1", null, title));
}

async function render(path: string) {
  await act(async () => {
    root.render(createElement(MemoryRouter, { basename: "/dashboard/", initialEntries: [path] },
      createElement(Probe),
      createElement(Routes, null,
        createElement(Route, { path: "/", element: createElement(Overview) }),
        createElement(Route, { path: "/team", element: createElement(Other, { title: "Team page" }) }),
        createElement(Route, { path: "/how-to-use", element: createElement(Other, { title: "How to use page" }) }),
      ),
    ));
  });
}

function menuButton() {
  return host.querySelector("button.sidebar-toggle") as HTMLButtonElement;
}
function item(name: string) {
  return [...host.querySelectorAll("a, button")].find((el) => el.textContent === name) as HTMLElement;
}

it("scrolls to openings and does not export when that control is disabled", async () => {
  const section = {
    getBoundingClientRect: () => ({ top: 480 }),
    scrollIntoView: vi.fn(),
    focus: vi.fn(),
  };
  const scrollingElement = { scrollTop: 0 };
  const doc = {
    getElementById: (id: string) => (id === "openings" ? section : null),
    querySelector: (selector: string) => (selector === ".sidebar.is-open" ? { className: "sidebar is-open" } : null),
    scrollingElement,
    documentElement: { scrollTop: 0 },
    body: { scrollTop: 0 },
    defaultView: { scrollY: 20, scrollTo: vi.fn(), setTimeout: (fn: () => void) => { fn(); return 0; } },
  } as unknown as Document;
  expect(scrollToOpenings(doc)).toBe(false);
  (doc.querySelector as (selector: string) => unknown) = () => null;
  expect(scrollToOpenings(doc)).toBe(true);
  expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest", behavior: "auto" });
  expect(scrollingElement.scrollTop).toBe(500);
  expect(section.focus).toHaveBeenCalled();

  const button = document.createElement("button");
  button.dataset.exportOpenings = "";
  button.disabled = true;
  let clicks = 0;
  button.addEventListener("click", () => { clicks += 1; });
  document.body.append(button);
  await expect(clickOpeningsExport(document, 0)).resolves.toBe("unavailable");
  expect(clicks).toBe(0);
  button.disabled = false;
  await expect(clickOpeningsExport(document, 0)).resolves.toBe("clicked");
  expect(clicks).toBe(1);
  button.remove();
});

it("opens the openings section from another page and exports through the overview button", async () => {
  const css = readFileSync("dashboard/src/index.css", "utf8");
  expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*\.sidebar-panel \{ display: none/);
  expect(css).toMatch(/\.sidebar\.is-open \.sidebar-panel \{ display: flex/);
  expect(css).toMatch(/@media \(min-width: 981px\)[\s\S]*\.sidebar-toggle \{ display: none/);
  let scrolled = 0;
  const markScrolled = () => { scrolled += 1; };
  Element.prototype.scrollIntoView = markScrolled;
  HTMLElement.prototype.scrollIntoView = markScrolled;
  window.scrollTo = () => {};

  await render("/dashboard/team");
  expect(host.querySelector("[data-probe]")?.textContent).toBe("/team");
  expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".sidebar")?.classList.contains("is-open")).toBe(false);
  expect(item("All openings").getAttribute("href")).toBe("/dashboard/#openings");
  expect(item("Export CSV").tagName).toBe("BUTTON");

  await act(async () => { item("All openings").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await vi.waitFor(() => expect(host.querySelector("[data-probe]")?.textContent).toBe("/#openings"));
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("openings"));
  expect(scrolled).toBeGreaterThan(0);
  expect(host.querySelector(".sidebar")?.classList.contains("is-open")).toBe(false);

  await act(async () => { item("Export CSV").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await vi.waitFor(() => expect(exported.n).toBe(1));
});

it("keeps the mobile menu collapsed until opened, then closes it after a choice", async () => {
  await render("/dashboard/team");
  const toggle = menuButton();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe("sidebar-menu");
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector(".sidebar")?.classList.contains("is-open")).toBe(true);
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
  expect(document.activeElement?.textContent).toBe("Portfolio Overview");

  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);

  await act(async () => { toggle.click(); });
  await act(async () => { item("How to use").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await vi.waitFor(() => expect(host.textContent).toContain("How to use page"));
  expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".sidebar.is-open")).toBeNull();
});

it("still shows Export CSV for an inspector and hides manager-only setup", async () => {
  auth.role = "inspector";
  await render("/dashboard/");
  expect(item("Export CSV")).toBeTruthy();
  expect(item("New opening")).toBeUndefined();
  expect(item("Import Openings")).toBeUndefined();
  expect(item("Schedule Comparisons")).toBeTruthy();
});
