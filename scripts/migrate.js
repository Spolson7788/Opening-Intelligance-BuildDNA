// Simple, dependency-free migration runner.
//
// Tracks applied migrations in a `schema_migrations` table so this is safe
// to run on every deploy — already-applied files are skipped. No down-
// migrations, no rollback tooling; at this stage that's the right tradeoff
// (less to get wrong) but worth outgrowing before this handles a lot of
// concurrent production writes.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.join(__dirname, "..", "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // filenames are prefixed 001_, 002_, etc. — sort order is apply order

    const appliedResult = await pool.query("SELECT filename FROM schema_migrations");
    const applied = new Set(appliedResult.rows.map((r) => r.filename));

    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log("No pending migrations.");
      await pool.end();
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`Applying ${file}...`);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`  ✓ ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ✗ ${file} failed:`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`Applied ${pending.length} migration(s).`);
    await pool.end();
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

main();
