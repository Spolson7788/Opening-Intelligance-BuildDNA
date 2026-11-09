import { expect, it } from "vitest";
import { assertRepairDatabase, repairPlan } from "../scripts/repair-inspection-visit-official-pdf.mjs";

it("plans a dry-run that only clears one frozen official report", () => {
  expect(() => assertRepairDatabase("postgres://user:secret@db.bekaxmatcvxqpjixwsqn.supabase.co:5432/postgres")).toThrow(/refusing_production/);
  expect(() => assertRepairDatabase("")).toThrow(/database_url_required/);
  expect(assertRepairDatabase("postgres://postgres:postgres@localhost:5432/opening_intel_test")).toBeUndefined();
  expect(repairPlan(undefined)).toEqual({ error: "visit_not_found" });
  expect(repairPlan({ id: "visit", report_storage_key: null })).toEqual({ error: "no_official_report" });
  const plan = repairPlan({
    id: "c2ec1beb-d191-4923-80b3-b1d3a8d58fad",
    organization_id: "org",
    inspector_user_id: "user",
    report_storage_key: "private/org/org/facility/facility/inspection-visit/c2ec1beb-d191-4923-80b3-b1d3a8d58fad.pdf",
    report_sha256: "abc",
    report_generated_at: "2026-11-09T10:57:00.000Z",
  });
  expect(plan.changes.inspection_visits.report_storage_key).toEqual({
    from: "private/org/org/facility/facility/inspection-visit/c2ec1beb-d191-4923-80b3-b1d3a8d58fad.pdf",
    to: null,
  });
  expect(plan.changes.inspection_visits.report_sha256.to).toBeNull();
  expect(plan.changes.inspection_visits.report_generated_at.to).toBeNull();
  expect(plan.changes.audit_log).toMatchObject({ action: "sync-race repair", wouldInsert: true });
  expect(plan.changes.storageObject.action).toContain("next send overwrites");
});
