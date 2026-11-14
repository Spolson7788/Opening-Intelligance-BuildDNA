// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { FACILITY_SECTIONS, FIELD_SECTIONS, HowToUse } from "../field-app/src/guide/howToUse";
import { HowToUsePage } from "../field-app/src/pages/HowToUsePage";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  viStub();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function viStub() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

function textOf(audience: "field" | "facility") {
  return (audience === "field" ? FIELD_SECTIONS : FACILITY_SECTIONS).map((section) => section.title);
}

it("keeps every section in the page while the sections are collapsed, and hides controls from print", async () => {
  await act(async () => root.render(<HowToUse audience="field" onAudience={() => {}} onBack={() => {}} />));
  const details = host.querySelectorAll("details");
  expect(details.length).toBe(FIELD_SECTIONS.length);
  details.forEach((item) => expect((item as HTMLDetailsElement).open).toBe(false));
  for (const title of textOf("field")) expect(host.textContent).toContain(title);
  expect(host.textContent).toContain("N/A does not mean Pass");
  expect(host.textContent).not.toContain("Save & next");
  expect(host.textContent).not.toContain("Testing accuracy");
  expect(host.innerHTML).toContain("@media print");
  expect(host.innerHTML).toContain(".no-print, aside[aria-label=\"Current account\"] { display: none");
  expect(host.querySelector(".no-print")).toBeTruthy();
  window.dispatchEvent(new Event("beforeprint"));
  details.forEach((item) => expect((item as HTMLDetailsElement).open).toBe(true));
  expect(host.textContent).toContain("N/A does not mean Pass");
  window.dispatchEvent(new Event("afterprint"));
  details.forEach((item) => expect((item as HTMLDetailsElement).open).toBe(false));
  expect(host.textContent).not.toContain("@example.com");
});

it("switches to the facility guide without leaving the technician sections in the page", async () => {
  function Harness() {
    const [audience, setAudience] = React.useState<"field" | "facility">("field");
    return <HowToUse audience={audience} onAudience={setAudience} />;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Facility staff");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.textContent).toContain("Purchasing email");
  expect(host.textContent).not.toContain("Identify hardware");
  for (const title of textOf("facility")) expect(host.textContent).toContain(title);
});

it("keeps the same guide text in the field app and the dashboard", () => {
  const field = readFileSync("field-app/src/guide/howToUse.tsx", "utf8");
  const facility = readFileSync("dashboard/src/guide/howToUse.tsx", "utf8");
  expect(field).toBe(facility);
});

it("opens the field guide without asking for a sign-in", async () => {
  await act(async () => root.render(<MemoryRouter><HowToUsePage /></MemoryRouter>));
  expect(host.textContent).toContain("How to use");
  expect(host.textContent).toContain("Technicians and inspectors");
  expect(host.textContent).toContain("Build test-build");
});
