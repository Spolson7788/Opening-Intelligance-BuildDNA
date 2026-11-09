import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const state = vi.hoisted(() => ({
  auth: { userId: "tech", organizationId: "11111111-1111-4111-8111-111111111111", email: "tech@example.invalid", role: "admin", mustChangePassword: false } as any,
  companies: [] as any[],
  switchCompany: vi.fn(),
}));
vi.mock("../field-app/src/lib/AuthContext", () => ({ useAuth: () => ({ auth: state.auth, loading: false, identityChecking: false, switchCompany: state.switchCompany }) }));
vi.mock("../field-app/src/lib/api", () => ({ fetchCompanies: async () => ({ companies: state.companies }) }));
import { AccountIdentity } from "../field-app/src/components/AccountIdentity";
import { CompanySwitcher } from "../field-app/src/components/CompanySwitcher";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const company = (id: string, name: string) => ({ organization_id: id, name, role: "admin", access: "member" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.auth = { userId: "tech", organizationId: ORG_A, email: "tech@example.invalid", role: "admin", mustChangePassword: false };
  state.companies = [company(ORG_A, "Synthetic Acceptance")];
  state.switchCompany.mockReset().mockResolvedValue({ kind: "switched" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render() {
  await act(async () => { root.render(<MemoryRouter><AccountIdentity /><CompanySwitcher /></MemoryRouter>); });
}

it("shows the company name without a picker or organization id for one company", async () => {
  await render();
  expect(host.textContent).toContain("Signed in as tech@example.invalid · Synthetic Acceptance");
  expect(host.querySelector("select")).toBeNull();
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/sync-issues");
  expect(host.textContent).not.toContain(ORG_A);
});

it("shows the picker for several companies and switches without printing organization ids", async () => {
  state.companies = [company(ORG_A, "Synthetic Acceptance"), { ...company(ORG_B, "Second Company"), access: "tree_view" }];
  await render();
  const select = host.querySelector("select") as HTMLSelectElement;
  expect(select).not.toBeNull();
  expect(select.options[0].textContent).toBe("Synthetic Acceptance");
  expect(select.options[1].textContent).toBe("Second Company (view only)");
  expect(host.textContent).not.toContain(ORG_A);
  expect(host.textContent).not.toContain(ORG_B);
  select.value = ORG_B;
  await act(async () => { select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(state.switchCompany).toHaveBeenCalledWith(ORG_B, false);
});
