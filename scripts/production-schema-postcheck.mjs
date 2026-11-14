// Read-only check after the production schema bundle.
// Refuses the production and staging project refs. Does not write.
import { Client } from "pg";

const refused = /bekaxmatcvxqpjixwsqn|boaoedvyvifppuklbwad/i;
const url = process.env.DATABASE_URL || "";
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (refused.test(url)) {
  console.error("Refusing hosted production or staging database. Post-check is for a local restore only.");
  process.exit(1);
}

const covered = [
  "016_password_reset.sql",
  "20261030090700_recognition_runs.sql",
  "20261030090800_recognition_budget_guard.sql",
  "20261030090900_recognition_revoke_public_access.sql",
  "20261030091000_reference_library.sql",
  "20261031090000_recognition_run_records.sql",
  "20261107130500_staff_mfa.sql",
  "20261107143000_staff_sign_in_codes.sql",
  "20261107203000_door_hardware_recognition.sql",
  "20261108143000_purchasing_department_email.sql",
  "20261108143100_nfpa80_fire_door_inspections.sql",
  "20261108150000_inspector_license_and_facility_contact.sql",
  "20261108160000_inspection_report_records.sql",
  "20261108171000_fire_door_api_policies.sql",
  "20261108180000_purchasing_api_policies.sql",
  "20261108181500_purchasing_api_insert_policies.sql",
  "20261109170000_inspection_visits.sql",
  "20261109173000_inspection_visit_official_pdf.sql",
  "20261109190000_inspection_visits_policies.sql",
  "20261111210000_company_dashboard_phase2.sql",
];

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const policies = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'prod_api_%'");
  const ledger = await client.query("SELECT filename FROM public.schema_migrations WHERE filename = ANY($1::text[])", [covered]);
  const tables = await client.query(`SELECT to_regclass('public.provider_accounts') AS accounts,
    to_regclass('public.inspection_visits') AS visits,
    to_regclass('public.purchasing_sends') AS purchasing,
    to_regclass('public.fire_door_deficiencies') AS deficiencies,
    to_regclass('public.service_routes') AS routes`);
  const newPolicy = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='provider_accounts' AND policyname='prod_api_select'");
  await client.query("ROLLBACK");
  const found = new Set(ledger.rows.map((row) => row.filename));
  const report = {
    prod_api_policies: policies.rows[0].n,
    ledger_filenames: found.size,
    provider_accounts: tables.rows[0].accounts !== null,
    inspection_visits: tables.rows[0].visits !== null,
    purchasing_sends: tables.rows[0].purchasing !== null,
    fire_door_deficiencies: tables.rows[0].deficiencies !== null,
    service_routes: tables.rows[0].routes !== null,
    provider_accounts_prod_api_select: newPolicy.rows[0].n === 1,
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = report.prod_api_policies >= 69
    && report.ledger_filenames === covered.length
    && report.provider_accounts && report.inspection_visits && report.purchasing_sends
    && report.fire_door_deficiencies && report.service_routes
    && report.provider_accounts_prod_api_select;
  if (!ok) process.exitCode = 1;
} finally {
  await client.end();
}
