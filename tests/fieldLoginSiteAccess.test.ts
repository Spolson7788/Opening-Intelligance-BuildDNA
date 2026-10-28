import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loginFailureMessage, isSiteAccessLoginFailure } from "../field-app/src/lib/authResponse";
import { siteAccessRenewalUrl } from "../field-app/src/lib/siteAccess";

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
  it("uses the same allow-listed renewal URL as the opening and QR pages", () => {
    expect(siteAccessRenewalUrl("https://oi-video-workflows-staging.netlify.app")).toBe("https://app.netlify.com/edge-access?domain=oi-video-workflows-staging.netlify.app");
    expect(siteAccessRenewalUrl("https://evil.example")).toBeNull();
    expect(page).toContain("siteAccessRenewalUrl(window.location.origin)");
  });
  it("renders the renew button next to the site-access error and a small standing link, both in a new tab", () => {
    expect(page).toMatch(/isSiteAccessLoginFailure\(error\) && renewalUrl && <a [^>]*href=\{renewalUrl\} target="_blank" rel="noreferrer">Renew private site access<\/a>/);
    expect(page).toMatch(/\{renewalUrl && <p[^>]*><a href=\{renewalUrl\} target="_blank" rel="noreferrer">Renew private site access<\/a>/);
  });
});