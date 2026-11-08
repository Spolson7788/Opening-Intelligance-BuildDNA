// Local-test-only migration runner for PGlite. Production migrations remain
// untouched; PGlite lacks uuid-ossp, so the equivalent pgcrypto UUID function
// is substituted in memory before execution.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  const files = fs.readdirSync(path.join(__dirname, "..", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    let sql = fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8");
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, "");
    sql = sql.replace(/uuid_generate_v4\(\)/g, "gen_random_uuid()");
    await pool.query(sql);
  }
  await pool.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
