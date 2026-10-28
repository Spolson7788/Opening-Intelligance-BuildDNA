import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultTestAccount, inviteSendMessage, inviteStatusLabel, readInviteToken, teamErrorMessage, EMAIL_NOT_CONFIGURED } from "../dashboard/src/lib/teamUi";
import { decodeTokenPayload } from "../dashboard/src/lib/api";

const jwtWith = (claims: object) => ["x", Buffer.from(JSON.stringify(claims)).toString("base64url"), "y"].join(".");

describe("M5 Team page helpers", () => {
  it("defaults the test-account box on only for .invalid addresses", () => {
    expect(defaultTestAccount("stg-tech-a@oi-nonprod.invalid")).toBe(true);
    expect(defaultTestAccount("tech@example.com")).toBe(false);
  });
  it("says exactly when email is not configured", () => {
    expect(EMAIL_NOT_CONFIGURED).toBe("Email not configured, invite not sent.");
    expect(inviteSendMessage("not_configured", "a@example.com").text.startsWith(EMAIL_NOT_CONFIGURED)).toBe(true);
    expect(inviteSendMessage("sent", "a@example.com").tone).toBe("ok");
    expect(inviteStatusLabel({ email_status: "sent", expired: true })).toBe("Expired");
    expect(teamErrorMessage("invite_rate_limited", 120)).toContain("2 minute");
    expect(teamErrorMessage("role_above_creator")).toContain("above your own");
  });
  it("reads the invite token only from the fragment", () => {
    const tok = "A".repeat(43);
    expect(readInviteToken("#invite=" + tok)).toBe(tok);
    expect(readInviteToken("#invite=short")).toBeNull();
    expect(readInviteToken("")).toBeNull();
  });
  it("decodes the mustChangePassword claim (base64url)", () => {
    expect(decodeTokenPayload(jwtWith({ userId: "u", organizationId: "o", role: "admin", mustChangePassword: true })).mustChangePassword).toBe(true);
    expect(decodeTokenPayload(jwtWith({ userId: "u", organizationId: "o", role: "admin" })).mustChangePassword).toBe(false);
  });
  it("wires the routes, the gate and the two add modes", () => {
    const dash = readFileSync("dashboard/src/App.tsx", "utf8"), field = readFileSync("field-app/src/App.tsx", "utf8");
    const team = readFileSync("dashboard/src/pages/TeamPage.tsx", "utf8");
    expect(dash).toContain('path="/accept-invite"'); expect(dash).toContain('path="/change-password"'); expect(dash).toContain("auth.mustChangePassword");
    expect(field).toContain('path="/change-password"'); expect(field).toContain("!passwordGate");
    for (const s of ["+ Add team member", "Set temporary password", "Email invite", "Test account", "Default facility", "Pending invites", "Resend", "Revoke"]) expect(team).toContain(s);
    expect(team).not.toContain("/auth/register");
    expect(readFileSync("field-app/src/components/FacilitySelector.tsx", "utf8")).toContain("default_property_id");
  });
});