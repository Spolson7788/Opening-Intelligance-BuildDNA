import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError } from "../dashboard/src/lib/api";
import {
  SESSION_EXPIRED_MESSAGE, TOKEN_KEY, handleUnauthorized, isTokenExpired, readValidToken, sessionExpiredUrl, tokenExpiresAtMs,
} from "../dashboard/src/lib/session";
import { facilitiesErrorMessage } from "../dashboard/src/lib/scheduleUi";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const tokenWith = (payload: Record<string, unknown>) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
function store(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { m, getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); } };
}
const NOW = Date.UTC(2026, 9, 28, 11, 0, 0);

describe("M3.1 (2): expired token is dropped on startup", () => {
  it("reads exp from the token", () => {
    expect(tokenExpiresAtMs(tokenWith({ exp: NOW / 1000 }))).toBe(NOW);
    expect(tokenExpiresAtMs("not-a-token")).toBeNull();
  });
  it("treats past exp and malformed tokens as expired, future exp as valid", () => {
    expect(isTokenExpired(tokenWith({ exp: NOW / 1000 - 60 }), NOW)).toBe(true);
    expect(isTokenExpired(tokenWith({ exp: NOW / 1000 + 3600 }), NOW)).toBe(false);
    expect(isTokenExpired("garbage", NOW)).toBe(true);
  });
  it("removes an expired token before any request and keeps a valid one", () => {
    const expired = store({ [TOKEN_KEY]: tokenWith({ userId: "u", exp: NOW / 1000 - 1 }) });
    expect(readValidToken(expired, NOW)).toBeNull();
    expect(expired.m.has(TOKEN_KEY)).toBe(false);
    const valid = tokenWith({ userId: "u", exp: NOW / 1000 + 43200 });
    const ok = store({ [TOKEN_KEY]: valid });
    expect(readValidToken(ok, NOW)).toBe(valid);
    expect(ok.m.has(TOKEN_KEY)).toBe(true);
    expect(readValidToken(store(), NOW)).toBeNull();
    expect(readValidToken(null, NOW)).toBeNull();
  });
});

describe("M3.1 (1): a 401 clears the token and goes to the dashboard sign-in", () => {
  it("builds the sign-in url under the dashboard base", () => {
    expect(sessionExpiredUrl("/dashboard/")).toBe("/dashboard/login?expired=1");
    expect(sessionExpiredUrl("/dashboard")).toBe("/dashboard/login?expired=1");
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your session expired. Sign in again.");
  });
  it("clears the token and navigates", () => {
    const s = store({ [TOKEN_KEY]: "t" }); const assign = vi.fn();
    handleUnauthorized(s, { pathname: "/dashboard/facility-schedules", assign }, "/dashboard/");
    expect(s.m.has(TOKEN_KEY)).toBe(false);
    expect(assign).toHaveBeenCalledWith("/dashboard/login?expired=1");
  });
  it("does not loop when already on the sign-in page", () => {
    const s = store({ [TOKEN_KEY]: "t" }); const assign = vi.fn();
    handleUnauthorized(s, { pathname: "/dashboard/login", assign }, "/dashboard/");
    expect(assign).not.toHaveBeenCalled();
    expect(s.m.has(TOKEN_KEY)).toBe(false);
  });
  it("authedFetch calls the handler on 401 and the login page shows the notice", () => {
    const api = readFileSync("dashboard/src/lib/api.ts", "utf8");
    expect(api).toMatch(/if \(res\.status === 401\) \{\s*\/\/[^\n]*\n\s*handleUnauthorized\(/);
    const login = readFileSync("dashboard/src/pages/LoginPage.tsx", "utf8");
    expect(login).toContain("SESSION_EXPIRED_MESSAGE");
    const ctx = readFileSync("dashboard/src/lib/AuthContext.tsx", "utf8");
    expect(ctx).toContain("readValidToken(");
  });
});

describe("M3.1 (3)(4): facility load failures are shown, with status and Retry", () => {
  it("includes the status in the message", () => {
    expect(facilitiesErrorMessage(new ApiError(503, "database_unavailable"))).toBe("Could not load facilities (503 database_unavailable). Try again.");
    expect(facilitiesErrorMessage(new ApiError(401, "invalid_token"))).toBe(SESSION_EXPIRED_MESSAGE);
    expect(facilitiesErrorMessage(new TypeError("Failed to fetch"))).toBe("Could not load facilities (network error). Try again.");
  });
  it("the dashboard no longer swallows listProperties failures", () => {
    const dash = readFileSync("dashboard/src/pages/DashboardPage.tsx", "utf8");
    expect(dash).not.toContain("listProperties().catch(() => [])");
    expect(dash).toContain("setPropertiesError(facilitiesErrorMessage(err))");
  });
  it("schedules and import start pages offer Retry", () => {
    for (const p of ["dashboard/src/pages/FacilitySchedulesPage.tsx", "dashboard/src/pages/ScheduleImportPage.tsx"]) {
      const src = readFileSync(p, "utf8");
      expect(src).toContain("facilitiesErrorMessage(err)");
      expect(src).toMatch(/>Retry<\/button>/);
    }
  });
});