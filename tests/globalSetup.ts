import { Client } from "pg";
import { execSync } from "node:child_process";

// Self-contained: doesn't rely on vitest's `test.env` having propagated yet,
// since globalSetup can run before that. Mirrors vitest.config.ts's default.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/opening_intel_test";

function parseDbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

export async function setup() {
  const dbName = parseDbName(TEST_DATABASE_URL);
  const adminUrl = TEST_DATABASE_URL.replace(`/${dbName}`, "/postgres");

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Fresh database every test run — simpler and more honest than trying to
    // reset state between individual tests. Terminate any lingering
    // connections first or DROP DATABASE will fail with "database is being
    // accessed by other users".
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  execSync("node scripts/migrate.js", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });
}

export async function teardown() {
  // Deliberately leave the test database in place after the run — inspecting
  // it after a failure is more useful than tearing it down, and the next
  // run's setup() drops and recreates it anyway.
}
