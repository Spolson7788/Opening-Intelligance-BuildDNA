import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../dashboard/src/lib/api";
import {
  NO_FACILITIES_MESSAGE, clearImportDraft, importDraftKey, isEmptyResolutions, kindForFilename,
  loadImportDraft, loginErrorMessage, saveImportDraft, type DraftStorage,
} from "../dashboard/src/lib/scheduleUi";

function memStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}
const empty = { rows: {}, set_map: {}, row_sets: {}, accept_items: [], overwrite: [] };

describe("M3 item 2: schedule type from file name", () => {
  it("maps docx to hardware and spreadsheets to door", () => {
    expect(kindForFilename("HW Schedule.DOCX")).toBe("hardware");
    expect(kindForFilename("doors.xlsx")).toBe("door");
    expect(kindForFilename("doors.csv")).toBe("door");
    expect(kindForFilename("doors.xls")).toBe("door");
  });
  it("leaves the choice alone for pdf or unknown files", () => {
    expect(kindForFilename("plans.pdf")).toBeNull();
    expect(kindForFilename("noextension")).toBeNull();
  });
});

describe("M3 item 5: review choices survive a reload", () => {
  it("round-trips per import id and clears after confirm", () => {
    const s = memStorage();
    const res = { ...empty, set_map: { A: "A1" }, rows: { r1: { skip: true } } };
    saveImportDraft("imp-1", res, s);
    expect(loadImportDraft("imp-1", s)).toEqual(res);
    expect(loadImportDraft("imp-2", s)).toBeNull();
    clearImportDraft("imp-1", s);
    expect(loadImportDraft("imp-1", s)).toBeNull();
  });
  it("does not keep empty choices and ignores corrupt entries", () => {
    const s = memStorage();
    saveImportDraft("imp-1", empty, s);
    expect(s.map.size).toBe(0);
    expect(isEmptyResolutions(empty)).toBe(true);
    s.setItem(importDraftKey("bad"), "{not json");
    expect(loadImportDraft("bad", s)).toBeNull();
    s.setItem(importDraftKey("old"), JSON.stringify({ v: 0, res: { set_map: { A: "A1" } } }));
    expect(loadImportDraft("old", s)).toBeNull();
  });
  it("tolerates missing or throwing storage", () => {
    const boom: DraftStorage = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(() => saveImportDraft("i", { ...empty, overwrite: ["k"] }, boom)).not.toThrow();
    expect(loadImportDraft("i", boom)).toBeNull();
    expect(loadImportDraft("i", null)).toBeNull();
  });
});

describe("M3 item 6: no-facility notice", () => {
  it("tells the user to switch accounts", () => {
    expect(NO_FACILITIES_MESSAGE).toMatch(/no facilities/i);
    expect(NO_FACILITIES_MESSAGE).toMatch(/account that owns the facility/);
  });
});

describe("M3 item 7: login error text", () => {
  it("only blames the password for invalid_credentials", () => {
    expect(loginErrorMessage(new ApiError(401, "invalid_credentials"))).toBe("Email or password didn't match. Try again.");
    expect(loginErrorMessage(new ApiError(403, "account_deactivated"))).toBe("This account is deactivated.");
    const unreachable = "Couldn't reach the sign-in service. Reload the page and try again.";
    expect(loginErrorMessage(new ApiError(401, "login_failed"))).toBe(unreachable);
    expect(loginErrorMessage(new ApiError(502, "login_failed"))).toBe(unreachable);
    expect(loginErrorMessage(new TypeError("Failed to fetch"))).toBe(unreachable);
  });
});

describe("M3 item 8: root redirect", () => {
  const src = readFileSync("scripts/build-isolated-release.mjs", "utf8");
  const lines = src.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes("_redirects") && l.includes("writeFileSync"));
  const line = lines.slice(at, at + 2).join(" ");
  it("sends only the site root to /dashboard/ ahead of the SPA rules", () => {
    expect(line).toContain('"/ /dashboard/ 302!\\n/field/* /field/index.html 200\\n/dashboard/* /dashboard/index.html 200\\n"');
    expect(line).not.toContain("facility-dashboard");
    expect(line).not.toContain('"/* ');
    expect(line).not.toContain('\\n/* ');
  });
});