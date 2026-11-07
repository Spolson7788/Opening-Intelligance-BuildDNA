import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

// Staff emailed sign-in codes. Disposable in-memory database only. This file applies the
// migration SQL inside that process; it does not connect to a database server.
const state = vi.hoisted(() => ({ db: null as any, emails: [] as { to: string; subject: string; text: string }[] }));
vi.mock("../src/db/pool", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => state.db.query(sql, params),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => state.db.query(sql, params), release: () => {} }),
  },
}));
import { createApp } from "../src/app";

const app = createApp();
const sql = (text: string, params?: unknown[]) => state.db.query(text, params);
const fix = (text: string) => text.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, "").replace(/uuid_generate_v4\(\)/g, "gen_random_uuid()");
const PASS = "synthetic-staff-pass-1";
const id: Record<string, string> = {};
const passwordOnly = (user: string) => jwt.sign(
  { userId: id[user], organizationId: id.oi, role: "admin", sessionVersion: 0 },
  process.env.JWT_SECRET!
);

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).includes("api.resend.com")) throw new Error("unexpected_fetch");
    const body = JSON.parse(String(init?.body));
    state.emails.push({ to: body.to[0], subject: body.subject, text: body.text });
    return new Response("{}", { status: 200 });
  });
  state.db = new PGlite();
  await state.db.exec("CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;");
  for (const name of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    await state.db.exec(fix(readFileSync("migrations/" + name, "utf8")));
  }
  const hash = bcrypt.hashSync(PASS, 4);
  id.oi = randomUUID();
  id.customerOrg = randomUUID();
  await sql("INSERT INTO organizations (id, name, org_type) VALUES ($1, 'Synthetic OI', 'internal')", [id.oi]);
  await sql("INSERT INTO organizations (id, name, org_type) VALUES ($1, 'Synthetic Customer', 'customer')", [id.customerOrg]);
  const addUser = async (key: string, org: string, email: string) => {
    id[key] = randomUUID();
    await sql(
      "INSERT INTO users (id, organization_id, email, full_name, role, password_hash) VALUES ($1, $2, $3, 'Synthetic', 'admin', $4)",
      [id[key], org, email, hash]
    );
  };
  await addUser("customer", id.customerOrg, "customer-mfa@example.invalid");
  await addUser("a", id.oi, "staff-a@example.invalid");
  await addUser("b", id.oi, "staff-b@example.invalid");
  await addUser("c", id.oi, "staff-c@example.invalid");
  await addUser("d", id.oi, "staff-d@example.invalid");
  for (const key of ["a", "b", "c"]) {
    await sql("INSERT INTO platform_staff (user_id, grant_reason) VALUES ($1, 'synthetic staff')", [id[key]]);
  }
}, 180000);

afterAll(async () => { await state.db?.close(); vi.unstubAllGlobals(); });

const login = (email: string) => request(app).post("/api/auth/login").send({ email, password: PASS });
const bearer = (token: string) => ({ Authorization: "Bearer " + token });
const codeFor = (email: string) => {
  const message = [...state.emails].reverse().find((item) => item.to === email);
  const code = message?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code || !message) throw new Error("missing_email_code");
  return { code, message };
};

describe("staff emailed sign-in code", () => {
  it("leaves customer login unchanged and sends them no code", async () => {
    const before = state.emails.length;
    const customer = await login("customer-mfa@example.invalid");
    expect(customer.status).toBe(200);
    expect(customer.body.mfa_required).toBeUndefined();
    expect(typeof customer.body.token).toBe("string");
    expect((jwt.decode(customer.body.token) as { mfaVerified?: boolean }).mfaVerified).toBeUndefined();
    expect(state.emails.length).toBe(before);
    const platform = await request(app).get("/api/platform/facilities").set(bearer(customer.body.token));
    expect(platform.status).toBe(403);
    expect(platform.body.error).toBe("forbidden");
  });

  it("emails a code after the password and rejects a password-only staff session", async () => {
    const logs: unknown[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    const started = await login("staff-a@example.invalid");
    const { code, message } = codeFor("staff-a@example.invalid");
    info.mockRestore();
    expect(started.body).toMatchObject({ mfa_required: true, expiresIn: "10m", resend_after_seconds: 60 });
    expect(started.body.token).toBeUndefined();
    expect(started.body.code).toBeUndefined();
    expect(message.subject).toBe("Your Opening Intelligence sign-in code");
    expect(message.text).toContain(code);
    expect(message.text).toContain("expires in 10 minutes");
    expect(JSON.stringify(logs)).not.toContain("sign-in code is");
    const stored = await sql("SELECT code_hash FROM staff_sign_in_codes WHERE user_id = $1 AND used_at IS NULL", [id.a]);
    expect(stored.rows[0].code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].code_hash).not.toBe(code);
    const legacy = passwordOnly("a");
    const facilities = await request(app).get("/api/platform/facilities").set(bearer(legacy));
    expect(facilities.status).toBe(403);
    expect(facilities.body.error).toBe("mfa_required");
    const companies = await request(app).get("/api/auth/companies").set(bearer(legacy));
    expect(companies.status).toBe(403);
    expect(companies.body.error).toBe("mfa_required");
    id.mfaA = started.body.mfa_token;
    id.codeA = code;
  });

  it("rejects a wrong code, accepts the emailed code once, and rejects reuse", async () => {
    const wrong = await request(app).post("/api/auth/mfa/verify").set(bearer(id.mfaA)).send({ code: id.codeA === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_mfa_code");
    const verified = await request(app).post("/api/auth/mfa/verify").set(bearer(id.mfaA)).send({ code: id.codeA });
    expect(verified.status).toBe(200);
    expect((jwt.decode(verified.body.token) as { mfaVerified?: boolean }).mfaVerified).toBe(true);
    const again = await request(app).post("/api/auth/mfa/verify").set(bearer(id.mfaA)).send({ code: id.codeA });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("mfa_code_reused");
    expect((await request(app).get("/api/platform/me").set(bearer(verified.body.token))).body.staff).toBe(true);
    id.tokenA = verified.body.token;
  });

  it("rejects an expired code", async () => {
    const started = await login("staff-b@example.invalid");
    const { code } = codeFor("staff-b@example.invalid");
    await sql("UPDATE staff_sign_in_codes SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL", [id.b]);
    const expired = await request(app).post("/api/auth/mfa/verify").set(bearer(started.body.mfa_token)).send({ code });
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe("mfa_code_expired");
  });

  it("makes a resent code replace the previous one after the cooldown", async () => {
    const started = await login("staff-b@example.invalid");
    const first = codeFor("staff-b@example.invalid").code;
    const tooSoon = await request(app).post("/api/auth/mfa/resend").set(bearer(started.body.mfa_token)).send({});
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error).toBe("resend_cooldown");
    await sql("UPDATE staff_sign_in_codes SET created_at = now() - interval '2 minutes' WHERE user_id = $1", [id.b]);
    const resent = await request(app).post("/api/auth/mfa/resend").set(bearer(started.body.mfa_token)).send({});
    expect(resent.body).toEqual({ sent: true, resend_after_seconds: 60 });
    const second = codeFor("staff-b@example.invalid").code;
    expect(second).not.toBe(first);
    const old = await request(app).post("/api/auth/mfa/verify").set(bearer(started.body.mfa_token)).send({ code: first });
    expect(old.status).toBe(401);
    expect(old.body.error).toBe("mfa_code_reused");
    const verified = await request(app).post("/api/auth/mfa/verify").set(bearer(started.body.mfa_token)).send({ code: second });
    expect(verified.status).toBe(200);
    id.tokenB = verified.body.token;
  });

  it("locks out five wrong codes and lets another verified staff member clear it", async () => {
    const started = await login("staff-c@example.invalid");
    const { code } = codeFor("staff-c@example.invalid");
    const bad = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await request(app).post("/api/auth/mfa/verify").set(bearer(started.body.mfa_token)).send({ code: bad })).status).toBe(401);
    }
    const limited = await request(app).post("/api/auth/mfa/verify").set(bearer(started.body.mfa_token)).send({ code });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("mfa_rate_limited");
    const self = await request(app).post("/api/platform/staff/" + id.b + "/mfa-unlock").set(bearer(id.tokenB)).send({ reason: "myself" });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("cannot_unlock_own_mfa");
    const passwordUnlock = await request(app).post("/api/platform/staff/" + id.c + "/mfa-unlock").set(bearer(passwordOnly("b"))).send({ reason: "password only" });
    expect(passwordUnlock.status).toBe(403);
    expect(passwordUnlock.body.error).toBe("mfa_required");
    const unlocked = await request(app).post("/api/platform/staff/" + id.c + "/mfa-unlock").set(bearer(id.tokenB)).send({ reason: "called and confirmed the lockout" });
    expect(unlocked.body).toEqual({ user_id: id.c, unlocked: true });
    const verified = await request(app).post("/api/auth/mfa/verify").set(bearer(started.body.mfa_token)).send({ code });
    expect(verified.status).toBe(200);
    const audit = await sql("SELECT request_body::text AS body FROM audit_log WHERE action = 'Cleared staff code lockout' AND user_id = $1", [id.b]);
    expect(audit.rows[0].body).toContain("called and confirmed the lockout");
    expect(audit.rows[0].body).not.toContain(code);
    expect(audit.rows[0].body).not.toContain(bad);
  });

  it("still re-grants staff through the 090600 function when the actor's code was accepted", async () => {
    const granted = await request(app).post("/api/platform/staff").set(bearer(id.tokenB)).send({ email: "staff-d@example.invalid", reason: "first hire" });
    expect(granted.status).toBe(201);
    const removed = await request(app).delete("/api/platform/staff/" + id.d).set(bearer(id.tokenB)).send({ reason: "left" });
    expect(removed.status).toBe(200);
    const restored = await request(app).post("/api/platform/staff").set(bearer(id.tokenB)).send({ email: "staff-d@example.invalid", reason: "back again" });
    expect(restored.status).toBe(201);
    expect(restored.body.regrant).toBe(true);
  });
});
