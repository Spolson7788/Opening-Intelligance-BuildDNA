import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loginFailureMessage, isSiteAccessLoginFailure } from "../field-app/src/lib/authResponse";
import { consumeFieldGateReturn, FIELD_AFTER_GATE, renewPrivateSiteAccess, siteAccessRenewalUrl } from "../field-app/src/lib/siteAccess";

const REF = "123e4567-e89b-42d3-a456-426614174000";
const page = readFileSync("field-app/src/pages/LoginPage.tsx", "utf8");

describe("field sign-in: renew private site access", () => {
  it("classifies a gate 401/403 (no app reference) as a site-access failure", () => {
    expect(isSiteAccessLoginFailure(loginFailureMessage(401, "login_failed"))).toBe(true);
    expect(isSiteAccessLoginFailure(loginFailureMessage(403, "login_failed"))).toBe(true);
  });
  it("does not offer renewal for real app sign-in failures", () => {
    expect(isSiteAccessLoginFailure(loginFailureMessage(401, "invalid_credentials", REF))).toBe(false);
    expect(isSiteAccessLoginFailure(loginFailureMessage(403, "account_deactivated", REF))).toBe(false);
    expect(isSiteAccessLoginFailure(loginFailureMessage(503, "authentication_service_unavailable", REF))).toBe(false);
  });
  it("opens the site root in this window and returns to the field app", () => {
    const origin = "https://oi-video-workflows-staging.netlify.app";
    expect(siteAccessRenewalUrl(origin)).toBe(`${origin}/`);
    expect(siteAccessRenewalUrl(origin)).not.toContain("?");
    expect(siteAccessRenewalUrl("https://evil.example")).toBeNull();
    expect(page).toContain("RenewPrivateSiteAccess");
    expect(page).not.toContain("edge-access");
    expect(page).not.toContain('target="_blank"');
    const assigned: string[] = [];
    const stored = new Map<string, string>();
    renewPrivateSiteAccess(
      { origin, assign: (url) => assigned.push(url) },
      { setItem: (key, value) => { stored.set(key, value); } },
    );
    expect(assigned).toEqual([`${origin}/`]);
    expect(stored.get("oi_field_after_gate")).toBe(FIELD_AFTER_GATE);
    const replaced: string[] = [];
    consumeFieldGateReturn(
      { getItem: (key) => stored.get(key) ?? null, removeItem: (key) => { stored.delete(key); } },
      "/dashboard/",
      (url) => replaced.push(url),
    );
    expect(replaced).toEqual(["/field/"]);
    expect(replaced[0]).not.toContain("?");
  });
});