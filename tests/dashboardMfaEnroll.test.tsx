import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ login: vi.fn(), adoptToken: vi.fn() }));
vi.mock("../dashboard/src/lib/AuthContext", () => {
  class StaffMfaRequired extends Error {
    mfaToken: string;
    constructor(mfaToken: string) {
      super("mfa_required");
      this.mfaToken = mfaToken;
    }
  }
  return { useAuth: () => state, StaffMfaRequired };
});
vi.mock("../dashboard/src/lib/api", async (orig) => {
  const actual = await orig<typeof import("../dashboard/src/lib/api")>();
  return { ...actual, resendStaffSignInCode: vi.fn(), verifyStaffMfa: vi.fn() };
});

import { LoginPage } from "../dashboard/src/pages/LoginPage";
import { StaffMfaRequired } from "../dashboard/src/lib/AuthContext";
import { resendStaffSignInCode } from "../dashboard/src/lib/api";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const futureToken = () => {
  const part = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + 600 })}.sig`;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  state.login.mockReset();
  state.adoptToken.mockReset();
  vi.mocked(resendStaffSignInCode).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("keeps the emailed code screen after a reload and does not send another code", async () => {
  state.login.mockRejectedValueOnce(new StaffMfaRequired(futureToken()));
  await act(async () => { root.render(<MemoryRouter><LoginPage /></MemoryRouter>); });
  const setInput = (selector: string, value: string) => {
    const input = host.querySelector(selector) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  await act(async () => {
    setInput("#email", "staff@example.invalid");
    setInput("#password", "synthetic-test-only");
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Email sign-in code");
  expect(host.textContent).toContain("staff@example.invalid");
  expect(host.textContent).toContain("Resend code");
  expect(resendStaffSignInCode).not.toHaveBeenCalled();
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><LoginPage /></MemoryRouter>); });
  expect(host.textContent).toContain("Email sign-in code");
  expect(host.textContent).toContain("staff@example.invalid");
  expect(state.login).toHaveBeenCalledTimes(1);
  expect(resendStaffSignInCode).not.toHaveBeenCalled();
});
