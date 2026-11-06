import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app, signupTestOrg } from "./helpers";
import { pool } from "../src/db/pool";

function enableMail() {
  process.env.RESEND_API_KEY = "test-email-api-key";
  process.env.PASSWORD_RESET_FROM_EMAIL = "OI <reset@example.test>";
  process.env.PASSWORD_RESET_PUBLIC_URL = "https://staging.example.test/";
  const sent: Array<{ to: string[]; text: string; subject: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
    sent.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ id: "email-test" }), { status: 200 });
  }));
  return sent;
}

function tokenFrom(message: { text: string }) {
  const match = message.text.match(/#token=([a-f0-9]{64})/);
  if (!match) throw new Error("No reset token found in test email");
  return match[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.PASSWORD_RESET_FROM_EMAIL;
  delete process.env.PASSWORD_RESET_PUBLIC_URL;
});

describe("OI password recovery", () => {
  it("shows Forgot password on both sign-in pages and keeps the signed-in change-password page", () => {
    const dashLogin = readFileSync("dashboard/src/pages/LoginPage.tsx", "utf8");
    const fieldLogin = readFileSync("field-app/src/pages/LoginPage.tsx", "utf8");
    const dashApp = readFileSync("dashboard/src/App.tsx", "utf8");
    const fieldApp = readFileSync("field-app/src/App.tsx", "utf8");
    expect(dashLogin).toContain('to="/forgot-password">Forgot password?');
    expect(fieldLogin).toContain('to="/forgot-password"');
    expect(fieldLogin).toContain("Forgot password?");
    expect(dashApp).toContain('path="/forgot-password"');
    expect(dashApp).toContain('path="/reset-password"');
    expect(dashApp).toContain('path="/change-password"');
    expect(fieldApp).toContain('path="/forgot-password"');
    expect(readFileSync("dashboard/src/pages/ChangePasswordPage.tsx", "utf8")).toContain("Change password");
  });

  it("changes only the signed-in account password and revokes the previous session", async () => {
    const owner = await signupTestOrg("Password owner");
    const other = await signupTestOrg("Other organization");
    const endpoint = () => request(app).post("/api/auth/change-password");
    const payload = { current_password: "testpassword123", new_password: "a-new-password-long-enough" };
    expect((await endpoint().send(payload)).status).toBe(401);
    const wrong = await endpoint().set("Authorization", `Bearer ${owner.token}`).send({ ...payload, current_password: "incorrect-password" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("current_password_incorrect");
    const unchanged = await endpoint().set("Authorization", `Bearer ${owner.token}`).send({ ...payload, new_password: payload.current_password });
    expect(unchanged.status).toBe(400);
    const changed = await endpoint().set("Authorization", `Bearer ${owner.token}`).send(payload);
    expect(changed.status).toBe(200);
    expect(changed.body.token).toEqual(expect.any(String));
    const revoked = await request(app).get("/api/openings").set("Authorization", `Bearer ${owner.token}`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe("session_revoked");
    expect((await request(app).post("/api/auth/login").send({ email: owner.email, password: payload.current_password })).status).toBe(401);
    const newLogin = await request(app).post("/api/auth/login").send({ email: owner.email, password: payload.new_password });
    expect(newLogin.status).toBe(200);
    expect((await request(app).get("/api/openings").set("Authorization", `Bearer ${newLogin.body.token}`)).status).toBe(200);
    expect((await request(app).get("/api/openings").set("Authorization", `Bearer ${other.token}`)).status).toBe(200);
    const org = await pool.query("SELECT organization_id FROM users WHERE email=$1", [owner.email]);
    expect(org.rows[0].organization_id).toBe(owner.organizationId);
  }, 20000);

  it("does not pretend an email was sent without a configured provider", async () => {
    const result = await request(app).post("/api/auth/password-reset/request").send({ email: "someone@example.test" });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("password_reset_unavailable");
  });

  it("uses the same response for unknown and known accounts, without exposing the token", async () => {
    const sent = enableMail();
    const org = await signupTestOrg();
    const known = await request(app).post("/api/auth/password-reset/request").send({ email: org.email });
    const unknown = await request(app).post("/api/auth/password-reset/request").send({ email: "unknown-person@example.test" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(known.body)).not.toContain(tokenFrom(sent[0]));
    expect(sent[0].to).toEqual([org.email]);
    expect(sent[0].text).toContain("https://staging.example.test/dashboard/reset-password#token=");
    expect(sent[0].text).not.toContain("organization_id");
  }, 20000);

  it("resets once, keeps the organization, revokes earlier sessions, and permits a new login", async () => {
    const sent = enableMail();
    const org = await signupTestOrg();
    const ignored = await request(app).post("/api/auth/password-reset/request").send({ email: org.email, organization_id: "not-allowed", redirect_url: "https://evil.example.test/" });
    expect(ignored.status).toBe(200);
    const token = tokenFrom(sent[0]);
    const invalid = await request(app).post("/api/auth/password-reset/confirm").send({ token: "a".repeat(64), password: "new-password-long-enough" });
    expect(invalid.status).toBe(400);
    const changed = await request(app).post("/api/auth/password-reset/confirm").send({ token, password: "new-password-long-enough" });
    expect(changed.status).toBe(200);
    const replay = await request(app).post("/api/auth/password-reset/confirm").send({ token, password: "different-password-long-enough" });
    expect(replay.status).toBe(400);
    const oldSession = await request(app).get("/api/openings").set("Authorization", `Bearer ${org.token}`);
    expect(oldSession.status).toBe(401);
    expect(oldSession.body.error).toBe("session_revoked");
    expect((await request(app).post("/api/auth/login").send({ email: org.email, password: "testpassword123" })).status).toBe(401);
    const newLogin = await request(app).post("/api/auth/login").send({ email: org.email, password: "new-password-long-enough" });
    expect(newLogin.status).toBe(200);
    expect((await request(app).get("/api/openings").set("Authorization", `Bearer ${newLogin.body.token}`)).status).toBe(200);
    const result = await pool.query("SELECT organization_id FROM users WHERE email=$1", [org.email]);
    expect(result.rows[0].organization_id).toBe(org.organizationId);
    const stored = await pool.query("SELECT token_hash FROM password_reset_tokens WHERE user_id=(SELECT id FROM users WHERE email=$1)", [org.email]);
    expect(stored.rows.every((row: { token_hash: string }) => row.token_hash !== token)).toBe(true);
  }, 20000);

  it("preserves pre-upgrade sessions until that account actually resets its password", async () => {
    const sent = enableMail();
    const org = await signupTestOrg();
    const user = await pool.query("SELECT id FROM users WHERE email=$1", [org.email]);
    const oldFormat = jwt.sign({ userId: user.rows[0].id, organizationId: org.organizationId, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "1h" });
    expect((await request(app).get("/api/openings").set("Authorization", `Bearer ${oldFormat}`)).status).toBe(200);
    await request(app).post("/api/auth/password-reset/request").send({ email: org.email });
    await request(app).post("/api/auth/password-reset/confirm").send({ token: tokenFrom(sent[0]), password: "replacement-password-long" });
    expect((await request(app).get("/api/openings").set("Authorization", `Bearer ${oldFormat}`)).status).toBe(401);
  }, 20000);

  it("rejects expired links and stops using tokens after delivery failure", async () => {
    const sent = enableMail();
    const org = await signupTestOrg();
    await request(app).post("/api/auth/password-reset/request").send({ email: org.email });
    const token = tokenFrom(sent[0]);
    await pool.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 minute' WHERE user_id=(SELECT id FROM users WHERE email=$1)", [org.email]);
    const expired = await request(app).post("/api/auth/password-reset/confirm").send({ token, password: "new-password-long-enough" });
    expect(expired.status).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider unavailable", { status: 503 })));
    const delivery = await request(app).post("/api/auth/password-reset/request").send({ email: org.email });
    expect(delivery.status).toBe(200);
    const stored = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS blocked FROM password_reset_tokens WHERE user_id=(SELECT id FROM users WHERE email=$1)", [org.email]);
    expect(stored.rows[0]).toMatchObject({ n: 2, blocked: 1 });
  }, 20000);

  it("limits requests to three messages per account per hour and gives throttled accounts the same response", async () => {
    const sent = enableMail();
    const org = await signupTestOrg();
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      request(app).post("/api/auth/password-reset/request").send({ email: org.email })
    ));
    expect(attempts.every((r) => r.status === 200)).toBe(true);
    expect(attempts.every((r) => JSON.stringify(r.body) === JSON.stringify(attempts[0].body))).toBe(true);
    expect(sent).toHaveLength(3);
  }, 20000);
});
