// Applies the production schema bundle to a local database only.
// Refuses oi-production (bekaxmatcvxqpjixwsqn) and staging (boaoedvyvifppuklbwad).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const refused = /bekaxmatcvxqpjixwsqn|boaoedvyvifppuklbwad/i;
const url = process.env.DATABASE_URL || "";
if (!url || refused.test(url)) {
  console.error("Refusing to apply the production bundle. DATABASE_URL must be a local restore, not production or staging.");
  process.exit(1);
}
const sql = resolve(fileURLToPath(new URL("..", import.meta.url)), "migrations/production/20261112140500_r59_production_schema.sql");
const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", sql], { stdio: "inherit" });
process.exit(result.status ?? 1);
