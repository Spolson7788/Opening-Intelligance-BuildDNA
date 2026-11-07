import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ login: vi.fn(), adoptToken: vi.fn() }));
vi.mock("../dashboard/src/lib/AuthContext", () => {
  class StaffMfaRequired extends Error {
    mfaToken: string;
    enrollmentRequired: boolean;
    constructor(mfaToken: string, enrollmentRequired: boolean) {
      super("mfa_required");
      this.mfaToken = mfaToken;
      this.enrollmentRequired = enrollmentRequired;
    }
  }
  return { useAuth: () => state, StaffMfaRequired };
});
vi.mock("../dashboard/src/lib/api", async (orig) => {
  const actual = await orig<typeof import("../dashboard/src/lib/api")>();
  return { ...actual, enrollStaffMfa: vi.fn(), verifyStaffMfa: vi.fn() };
});

import { LoginPage } from "../dashboard/src/pages/LoginPage";
import { StaffMfaRequired } from "../dashboard/src/lib/AuthContext";
import { enrollStaffMfa } from "../dashboard/src/lib/api";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.login.mockReset();
  state.adoptToken.mockReset();
  vi.mocked(enrollStaffMfa).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers the iPhone Passwords link and a setup-key copy button while enrolling", async () => {
  state.login.mockRejectedValueOnce(new StaffMfaRequired("pending-token", true));
  vi.mocked(enrollStaffMfa).mockResolvedValueOnce({
    otpauth_url: "otpauth://totp/Opening%20Intelligence:staff%40example.invalid?secret=SETUPKEY&issuer=Opening%20Intelligence&algorithm=SHA1&digits=6&period=30",
    secret: "SETUPKEY",
    qr_data_url: "data:image/png;base64,aaaa",
    recovery_codes: ["ABCDE-FGHIJ"],
    warning: "These codes are shown only once.",
  });
  await act(async () => { root.render(<MemoryRouter><LoginPage /></MemoryRouter>); });
  (host.querySelector("#email") as HTMLInputElement).value = "staff@example.invalid";
  (host.querySelector("#password") as HTMLInputElement).value = "synthetic-test-only";
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const add = host.querySelector("a.mfa-add-app");
  expect(add?.textContent).toBe("Add to authenticator app");
  expect(add?.getAttribute("href")).toBe("otpauth://totp/Opening%20Intelligence:staff%40example.invalid?secret=SETUPKEY&issuer=Opening%20Intelligence&algorithm=SHA1&digits=6&period=30");
  expect(add?.getAttribute("target")).toBeNull();
  expect(host.querySelector("img")?.getAttribute("alt")).toBe("Authenticator setup QR code");
  expect(host.querySelector("#setup-key")?.textContent).toBe("SETUPKEY");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const copy = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Copy setup key");
  await act(async () => { copy!.click(); });
  expect(writeText).toHaveBeenCalledWith("SETUPKEY");
});
