import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { totpCodeForBase32 } from "../src/services/staffMfaCrypto";

// SEC-2 staff authenticator. Disposable in-memory database only. This file applies the
// migration SQL inside that process; it does not connect to a database server.
const state = vi.hoisted(() => ({ db: null as any }));
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

afterAll(async () => { await state.db?.close(); });

const login = (email: string) => request(app).post("/api/auth/login").send({ email, password: PASS });
const auth = (token: string) => ({ Authorization: "Bearer " + token });

async function enrollAndConfirm(email: string) {
  const started = await login(email);
  expect(started.status).toBe(200);
  expect(started.body.token).toBeUndefined();
  expect(started.body.mfa_required).toBe(true);
  expect(started.body.enrollment_required).toBe(true);
  const enrolled = await request(app).post("/api/auth/mfa/enroll").set(auth(started.body.mfa_token)).send({});
  expect(enrolled.status).toBe(200);
  expect(enrolled.body.otpauth_url.startsWith("otpauth://totp/Opening%20Intelligence:")).toBe(true);
  expect(enrolled.body.otpauth_url).toContain(`secret=${enrolled.body.secret}`);
  expect(enrolled.body.otpauth_url).toContain("algorithm=SHA1");
  expect(enrolled.body.otpauth_url).toContain("digits=6");
  expect(enrolled.body.otpauth_url).toContain("period=30");
  expect(enrolled.body.otpauth_url.split("?")[0]).toContain(":");
  expect(enrolled.body.recovery_codes).toHaveLength(10);
  expect(new Set(enrolled.body.recovery_codes).size).toBe(10);
  expect(JSON.stringify(enrolled.body)).not.toMatch(/password_hash|secret_ciphertext/i);
  const current = totpCodeForBase32(enrolled.body.secret);
  const wrong = await request(app).post("/api/auth/mfa/verify").set(auth(started.body.mfa_token)).send({ code: current === "000000" ? "111111" : "000000" });
  expect(wrong.status).toBe(401);
  expect(wrong.body.error).toBe("invalid_mfa_code");
  const code = current;
  const verified = await request(app).post("/api/auth/mfa/verify").set(auth(started.body.mfa_token)).send({ code });
  expect(verified.status).toBe(200);
  expect((jwt.decode(verified.body.token) as { mfaVerified?: boolean }).mfaVerified).toBe(true);
  const replay = await request(app).post("/api/auth/mfa/verify").set(auth(started.body.mfa_token)).send({ code });
  expect(replay.status).toBe(401);
  expect(replay.body.error).toBe("mfa_code_reused");
  return { token: verified.body.token as string, secret: enrolled.body.secret as string, recoveryCodes: enrolled.body.recovery_codes as string[] };
}

describe("staff authenticator sign-in", () => {
  it("keeps the factor tables closed to the public database roles", async () => {
    const flags = await sql("SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relname LIKE 'staff_mfa%' ORDER BY relname");
    expect(flags.rows.map((row: { relname: string; relrowsecurity: boolean }) => [row.relname, row.relrowsecurity])).toEqual([
      ["staff_mfa_attempts", true],
      ["staff_mfa_factors", true],
      ["staff_mfa_recovery_codes", true],
    ]);
    const anon = await sql("SELECT has_table_privilege('anon', 'staff_mfa_factors', 'SELECT') AS can_read");
    expect(anon.rows[0].can_read).toBe(false);
    const fn = await sql("SELECT to_regprocedure('platform_staff_regrant(uuid,uuid,text)') IS NOT NULL AS present");
    expect(fn.rows[0].present).toBe(true);
  });

  it("leaves customer login and customer access unchanged", async () => {
    const customer = await login("customer-mfa@example.invalid");
    expect(customer.status).toBe(200);
    expect(customer.body.mfa_required).toBeUndefined();
    expect(typeof customer.body.token).toBe("string");
    expect((jwt.decode(customer.body.token) as { mfaVerified?: boolean; mfaPending?: boolean }).mfaVerified).toBeUndefined();
    expect((jwt.decode(customer.body.token) as { mfaPending?: boolean }).mfaPending).toBeUndefined();
    expect((await request(app).get("/api/auth/me").set(auth(customer.body.token))).status).toBe(200);
    const platform = await request(app).get("/api/platform/facilities").set(auth(customer.body.token));
    expect(platform.status).toBe(403);
    expect(platform.body.error).toBe("forbidden");
    const reset = await request(app).post("/api/platform/staff/" + id.a + "/mfa-reset").set(auth(customer.body.token)).send({ reason: "customer must not do this" });
    expect(reset.status).toBe(403);
    expect(reset.body.error).toBe("forbidden");
  });

  it("rejects a password-only staff session, including a staff re-grant attempt", async () => {
    const started = await login("staff-a@example.invalid");
    expect(started.body).toMatchObject({ mfa_required: true, enrollment_required: true });
    expect(started.body.token).toBeUndefined();
    const legacy = passwordOnly("a");
    const facilities = await request(app).get("/api/platform/facilities").set(auth(legacy));
    expect(facilities.status).toBe(403);
    expect(facilities.body.error).toBe("mfa_required");
    const companies = await request(app).get("/api/auth/companies").set(auth(legacy));
    expect(companies.status).toBe(403);
    expect(companies.body.error).toBe("mfa_required");
    const regrant = await request(app).post("/api/platform/staff").set(auth(legacy)).send({ email: "staff-d@example.invalid", reason: "password only must not regrant" });
    expect(regrant.status).toBe(403);
    expect(regrant.body.error).toBe("mfa_required");
    expect((await sql("SELECT revoked_at FROM platform_staff WHERE user_id = $1", [id.d])).rows).toEqual([]);
  });

  it("accepts one authenticator code, rejects a replay, and stores only a hash of each recovery code", async () => {
    const session = await enrollAndConfirm("staff-a@example.invalid");
    id.tokenA = session.token;
    id.recoveryA = session.recoveryCodes[0];
    const hashes = await sql("SELECT code_hash FROM staff_mfa_recovery_codes WHERE user_id = $1", [id.a]);
    expect(hashes.rows).toHaveLength(10);
    for (const row of hashes.rows) expect(session.recoveryCodes).not.toContain(row.code_hash);
    const secretRow = await sql("SELECT encode(secret_ciphertext, 'escape') AS stored FROM staff_mfa_factors WHERE user_id = $1", [id.a]);
    expect(secretRow.rows[0].stored).not.toContain(session.secret);
    expect((await request(app).get("/api/platform/facilities").set(auth(session.token))).status).toBe(200);
    expect((await request(app).get("/api/platform/me").set(auth(session.token))).body.staff).toBe(true);
  });

  it("lets a recovery code be used once", async () => {
    const again = await login("staff-a@example.invalid");
    expect(again.body).toMatchObject({ mfa_required: true, enrollment_required: false });
    const used = await request(app).post("/api/auth/mfa/verify").set(auth(again.body.mfa_token)).send({ recovery_code: id.recoveryA });
    expect(used.status).toBe(200);
    const third = await login("staff-a@example.invalid");
    const reused = await request(app).post("/api/auth/mfa/verify").set(auth(third.body.mfa_token)).send({ recovery_code: id.recoveryA });
    expect(reused.status).toBe(401);
    expect(reused.body.error).toBe("mfa_code_reused");
    const rows = await sql("SELECT count(*)::int AS n FROM staff_mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL", [id.a]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("lets the other verified staff member reset the authenticator and writes an audit record without secrets", async () => {
    const other = await enrollAndConfirm("staff-b@example.invalid");
    const reset = await request(app).post("/api/platform/staff/" + id.a + "/mfa-reset").set(auth(other.token)).send({ reason: "lost phone, identity checked on a known number" });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ user_id: id.a, reset: true });
    const self = await request(app).post("/api/platform/staff/" + id.b + "/mfa-reset").set(auth(other.token)).send({ reason: "self" });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("cannot_reset_own_mfa");
    const stale = await request(app).get("/api/platform/facilities").set(auth(id.tokenA));
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe("session_revoked");
    const fresh = await login("staff-a@example.invalid");
    expect(fresh.body).toMatchObject({ mfa_required: true, enrollment_required: true });
    const oldCode = await request(app).post("/api/auth/mfa/verify").set(auth(fresh.body.mfa_token)).send({ recovery_code: id.recoveryA });
    expect(oldCode.status).toBe(400);
    expect(oldCode.body.error).toBe("enrollment_required");
    const audit = await sql("SELECT action, request_body::text AS body FROM audit_log WHERE action = 'Reset staff authenticator' AND user_id = $1", [id.b]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].body).toContain("lost phone");
    expect(audit.rows[0].body).not.toContain(id.recoveryA);
    const event = await sql("SELECT action, reason FROM platform_audit_events WHERE action = 'staff_mfa_reset' AND target_id = $1", [id.a]);
    expect(event.rows[0]).toMatchObject({ action: "staff_mfa_reset", reason: "lost phone, identity checked on a known number" });
    id.tokenB = other.token;
  });

  it("still re-grants staff through the 090600 function when the actor's authenticator session is verified", async () => {
    const granted = await request(app).post("/api/platform/staff").set(auth(id.tokenB)).send({ email: "staff-d@example.invalid", reason: "first hire" });
    expect(granted.status).toBe(201);
    const removed = await request(app).delete("/api/platform/staff/" + id.d).set(auth(id.tokenB)).send({ reason: "left" });
    expect(removed.status).toBe(200);
    const restored = await request(app).post("/api/platform/staff").set(auth(id.tokenB)).send({ email: "staff-d@example.invalid", reason: "back again" });
    expect(restored.status).toBe(201);
    expect(restored.body.regrant).toBe(true);
    const history = await sql("SELECT count(*)::int AS n FROM platform_staff_grant_history WHERE user_id = $1", [id.d]);
    expect(history.rows[0].n).toBeGreaterThan(0);
    expect((await sql("SELECT is_platform_staff($1) AS staff", [id.d])).rows[0].staff).toBe(true);
  });

  it("rate-limits repeated wrong codes", async () => {
    const started = await login("staff-c@example.invalid");
    const enrolled = await request(app).post("/api/auth/mfa/enroll").set(auth(started.body.mfa_token)).send({});
    const good = totpCodeForBase32(enrolled.body.secret);
    const bad = good === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await request(app).post("/api/auth/mfa/verify").set(auth(started.body.mfa_token)).send({ code: bad });
      expect(failed.status).toBe(401);
    }
    const limited = await request(app).post("/api/auth/mfa/verify").set(auth(started.body.mfa_token)).send({ code: good });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("mfa_rate_limited");
    id.badCode = bad;
    id.mfaC = started.body.mfa_token;
  });

  it("lets another verified staff member clear the code lockout, and refuses a self unlock", async () => {
    const stillLocked = await request(app).post("/api/auth/mfa/verify").set(auth(id.mfaC)).send({ code: id.badCode });
    expect(stillLocked.status).toBe(429);
    const customer = await login("customer-mfa@example.invalid");
    const customerUnlock = await request(app).post("/api/platform/staff/" + id.c + "/mfa-unlock").set(auth(customer.body.token)).send({ reason: "customer must not do this" });
    expect(customerUnlock.status).toBe(403);
    expect(customerUnlock.body.error).toBe("forbidden");
    const passwordUnlock = await request(app).post("/api/platform/staff/" + id.c + "/mfa-unlock").set(auth(passwordOnly("b"))).send({ reason: "password only" });
    expect(passwordUnlock.status).toBe(403);
    expect(passwordUnlock.body.error).toBe("mfa_required");
    const self = await request(app).post("/api/platform/staff/" + id.b + "/mfa-unlock").set(auth(id.tokenB)).send({ reason: "myself" });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("cannot_unlock_own_mfa");
    const unlocked = await request(app).post("/api/platform/staff/" + id.c + "/mfa-unlock").set(auth(id.tokenB)).send({ reason: "called and confirmed the lockout" });
    expect(unlocked.body).toEqual({ user_id: id.c, unlocked: true });
    const retry = await request(app).post("/api/auth/mfa/verify").set(auth(id.mfaC)).send({ code: id.badCode });
    expect(retry.status).toBe(401);
    expect(retry.body.error).toBe("invalid_mfa_code");
    const audit = await sql("SELECT request_body::text AS body FROM audit_log WHERE action = 'Cleared staff code lockout' AND user_id = $1", [id.b]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].body).toContain("called and confirmed the lockout");
    expect(audit.rows[0].body).not.toContain(id.badCode);
    const event = await sql("SELECT reason FROM platform_audit_events WHERE action = 'staff_mfa_lockout_cleared' AND target_id = $1", [id.c]);
    expect(event.rows[0].reason).toBe("called and confirmed the lockout");
  });

  it("clears the lockout when another staff member resets the authenticator", async () => {
    // One failed try remains from the unlock check, so four more reach the limit.
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await request(app).post("/api/auth/mfa/verify").set(auth(id.mfaC)).send({ code: id.badCode })).status).toBe(401);
    }
    expect((await request(app).post("/api/auth/mfa/verify").set(auth(id.mfaC)).send({ code: id.badCode })).status).toBe(429);
    const reset = await request(app).post("/api/platform/staff/" + id.c + "/mfa-reset").set(auth(id.tokenB)).send({ reason: "reset also clears the lockout" });
    expect(reset.status).toBe(200);
    const fresh = await login("staff-c@example.invalid");
    expect(fresh.body.enrollment_required).toBe(true);
    const enrolled = await request(app).post("/api/auth/mfa/enroll").set(auth(fresh.body.mfa_token)).send({});
    expect(enrolled.status).toBe(200);
    const freshCode = totpCodeForBase32(enrolled.body.secret);
    const wrong = freshCode === id.badCode ? (id.badCode === "000000" ? "111111" : "000000") : id.badCode;
    const attempt = await request(app).post("/api/auth/mfa/verify").set(auth(fresh.body.mfa_token)).send({ code: wrong });
    expect(attempt.status).toBe(401);
    expect(attempt.body.error).toBe("invalid_mfa_code");
  });
});
