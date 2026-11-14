// Proves the phase 2 migration on a local copy of the schema. Refuses production.
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/opening_intel_test";
if (/bekaxmatcvxqpjixwsqn/i.test(source)) {
  console.error("Refusing to run: this check must not use oi-production.");
  process.exit(1);
}
const dbName = "opening_intel_phase2_check";
const adminUrl = source.replace(/\/[^/]+$/, "/postgres");
const checkUrl = source.replace(/\/[^/]+$/, `/${dbName}`);
const migration = "20261111210000_company_dashboard_phase2.sql";
const files = readdirSync(resolve(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();

async function apply(client, name) {
  await client.query(readFileSync(resolve(root, "migrations", name), "utf8"));
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const db = new pg.Client({ connectionString: checkUrl });
await db.connect();
for (const name of files) {
  if (name === migration) continue;
  await apply(db, name);
}

const provider = randomUUID();
const customer = randomUUID();
const portfolio = randomUUID();
const customerPortfolio = randomUUID();
const maple = randomUUID();
const walkA = randomUUID();
const walkB = randomUUID();
const clinic = randomUUID();
const building = randomUUID();
const opening = randomUUID();
const estimate = randomUUID();
const user = randomUUID();
await db.query("INSERT INTO organizations (id, name, org_type) VALUES ($1,'Harbor Door','service_partner'), ($2,'Northwind Clinics','customer')", [provider, customer]);
await db.query("INSERT INTO users (id, organization_id, email, full_name, role, password_hash) VALUES ($1,$2,'phase2@example.invalid','Phase Two','admin','unused')", [user, customer]);
await db.query("INSERT INTO portfolios (id, organization_id, name) VALUES ($1,$2,'Main'), ($3,$4,'Customer')", [portfolio, provider, customerPortfolio, customer]);
await db.query(
  "INSERT INTO properties (id, portfolio_id, name) VALUES ($1,$2,'Maple Street Offices'), ($3,$2,'Walk-in calls'), ($4,$2,'walk in bucket'), ($5,$6,'Clinic Way')",
  [maple, portfolio, walkA, walkB, clinic, customerPortfolio],
);
await db.query("INSERT INTO buildings (id, property_id, name) VALUES ($1,$2,'Main')", [building, maple]);
await db.query("INSERT INTO openings (id, opening_code, building_id, opening_type, qr_token) VALUES ($1,$2,$3,'door',$4)", [opening, "PHASE2-" + opening.slice(0, 8), building, randomUUID()]);
await db.query("INSERT INTO replacement_estimates (id, provider_id, opening_id) VALUES ($1,$2,$3)", [estimate, provider, opening]);
await db.query(
  "INSERT INTO facility_provider_assignments (property_id, provider_organization_id, granted_by_user_id) VALUES ($1,$2,$3)",
  [clinic, provider, user],
);
const before = await db.query("SELECT count(*)::int AS n FROM openings");

await apply(db, migration);
await apply(db, migration);

const kinds = await db.query(
  `SELECT property.name, account.kind, account.display_name
   FROM provider_account_sites site
   JOIN provider_accounts account ON account.id = site.account_id
   JOIN properties property ON property.id = site.property_id
   ORDER BY property.name`,
);
const byName = Object.fromEntries(kinds.rows.map((row) => [row.name, row]));
if (byName["Maple Street Offices"].kind !== "small") throw new Error("Maple was not stored as small");
if (byName["Walk-in calls"].kind !== "walkin" || byName["walk in bucket"].kind !== "walkin") throw new Error("Walk-in sites were not stored in the bucket");
if (byName["Walk-in calls"].display_name !== "Walk-in") throw new Error("Walk-in bucket was duplicated or renamed");
const buckets = await db.query("SELECT count(*)::int AS n FROM provider_accounts WHERE provider_organization_id=$1 AND kind='walkin'", [provider]);
if (buckets.rows[0].n !== 1) throw new Error("A provider has more than one Walk-in bucket");
const facility = await db.query(
  "SELECT kind FROM provider_accounts WHERE provider_organization_id=$1 AND customer_organization_id=$2",
  [provider, customer],
);
if (facility.rows[0]?.kind !== "facility") throw new Error("The granted customer site was not stored as a facility account");
const estimateRow = await db.query("SELECT approval_status FROM replacement_estimates WHERE id=$1", [estimate]);
if (estimateRow.rows[0].approval_status !== "draft") throw new Error("Existing estimate did not default to draft");
const after = await db.query("SELECT count(*)::int AS n FROM openings");
if (after.rows[0].n !== before.rows[0].n) throw new Error("The migration changed the number of openings");
await db.query("SELECT 1 FROM service_routes LIMIT 0");
await db.query("SELECT 1 FROM service_route_stops LIMIT 0");
await db.query("SELECT 1 FROM work_pickup_eligibility LIMIT 0");

await db.query(readFileSync(resolve(root, "docs/rollback/20261111210000_company_dashboard_phase2_rollback.sql"), "utf8"));
const gone = await db.query("SELECT to_regclass('public.provider_accounts') AS accounts, to_regclass('public.service_routes') AS routes");
if (gone.rows[0].accounts || gone.rows[0].routes) throw new Error("Rollback left the new tables in place");
const still = await db.query("SELECT id FROM openings WHERE id=$1", [opening]);
const estimateStill = await db.query("SELECT id FROM replacement_estimates WHERE id=$1", [estimate]);
if (!still.rows.length || !estimateStill.rows.length) throw new Error("Rollback removed existing records");
const column = await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='replacement_estimates' AND column_name='approval_status'");
if (column.rows.length) throw new Error("Rollback left approval_status in place");

await apply(db, migration);
const restored = await db.query("SELECT kind FROM provider_accounts a JOIN provider_account_sites s ON s.account_id=a.id WHERE s.property_id=$1", [maple]);
if (restored.rows[0]?.kind !== "small") throw new Error("Re-applying the migration did not restore the small account");
await db.end();
console.log(JSON.stringify({ database: dbName, migration, openings: after.rows[0].n, accounts: kinds.rows, rollback: "removed new tables and kept existing records" }));
