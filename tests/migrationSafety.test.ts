import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("offline migration recovery safety", () => {
  it("has one canonical migration number 014 and one storage object column", () => {
    const migrations = readdirSync(join(root, "migrations"));
    expect(migrations.filter((name) => name.startsWith("014_"))).toEqual(["014_offline_sync_foundation.sql"]);
    const sql = readFileSync(join(root, "migrations/014_offline_sync_foundation.sql"), "utf8");
    expect(sql).toContain("storage_object_key");
    expect(sql).not.toMatch(/ADD COLUMN storage_key\b/);
  });

  it("keeps RLS enabled and revokes browser roles in the 015 recovery procedure", () => {
    const sql = readFileSync(join(root, "docs/rollback/015_harden_supabase_data_api_rollback.sql"), "utf8");
    expect(sql).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).toMatch(/REVOKE ALL[\s\S]+FROM authenticated/i);
    expect(sql).toMatch(/REVOKE ALL[\s\S]+FROM anon/i);
  });

  it("provides a paired, explicit rollback for the canonical 014 migration", () => {
    const sql = readFileSync(join(root, "docs/rollback/014_offline_sync_foundation_rollback.sql"), "utf8");
    expect(sql).toContain("DROP TABLE IF EXISTS photo_deletion_jobs");
    expect(sql).toContain("DROP TABLE IF EXISTS photo_upload_reservations");
    expect(sql).toContain("DROP COLUMN IF EXISTS storage_object_key");
  });
});
