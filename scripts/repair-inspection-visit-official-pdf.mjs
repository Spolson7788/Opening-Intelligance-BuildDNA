// One-shot repair for a combined-report PDF frozen before every door synced.
// Dry-run unless --confirm. Not called by the app. Does not publish.
// Refuses production. Clears the official-report columns for one visit so the
// next send writes a new PDF from the inspections on the server now.
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const PRODUCTION_PROJECT = 'bekaxmatcvxqpjixwsqn';

export function assertRepairDatabase(databaseUrl) {
  if (!databaseUrl) {
    const error = new Error('database_url_required');
    error.code = 'database_url_required';
    throw error;
  }
  if (databaseUrl.toLowerCase().includes(PRODUCTION_PROJECT)) {
    const error = new Error('refusing_production');
    error.code = 'refusing_production';
    throw error;
  }
}

export function repairPlan(row) {
  if (!row) return { error: 'visit_not_found' };
  if (!row.report_storage_key) return { error: 'no_official_report' };
  return {
    visitId: row.id,
    changes: {
      inspection_visits: {
        id: row.id,
        report_storage_key: { from: row.report_storage_key, to: null },
        report_sha256: { from: row.report_sha256, to: null },
        report_generated_at: { from: row.report_generated_at, to: null },
      },
      audit_log: { action: 'sync-race repair', organization_id: row.organization_id, user_id: row.inspector_user_id, wouldInsert: true },
      storageObject: { key: row.report_storage_key, action: 'left in place; the next send overwrites this key' },
    },
  };
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) return '';
  return process.argv[index + 1];
}

async function main() {
  const visitId = optionValue('--visit-id');
  const confirm = process.argv.includes('--confirm');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitId)) {
    console.error('Refusing to run: pass one --visit-id.');
    process.exitCode = 1;
    return;
  }
  try { assertRepairDatabase(process.env.DATABASE_URL); }
  catch (error) {
    console.error(error.code === 'refusing_production' ? 'Refusing to run: DATABASE_URL points at production.' : 'Refusing to run: DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const found = await client.query(
      `SELECT id, organization_id, inspector_user_id, report_storage_key, report_sha256, report_generated_at
       FROM inspection_visits WHERE id = $1`,
      [visitId],
    );
    const plan = repairPlan(found.rows[0]);
    if (plan.error) {
      console.error(plan.error === 'visit_not_found' ? 'Refusing to run: that visit was not found.' : 'Refusing to run: this visit has no official report yet.');
      process.exitCode = 1;
      return;
    }
    const report = { dryRun: !confirm, applied: false, ...plan };
    if (!confirm) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    await client.query('BEGIN');
    const cleared = await client.query(
      `UPDATE inspection_visits
       SET report_storage_key = NULL, report_sha256 = NULL, report_generated_at = NULL
       WHERE id = $1 AND report_storage_key IS NOT NULL
       RETURNING id`,
      [visitId],
    );
    if (!cleared.rowCount) {
      await client.query('ROLLBACK');
      console.error('Refusing to run: the official report was already cleared.');
      process.exitCode = 1;
      return;
    }
    await client.query(
      `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code)
       VALUES ($1,$2,'sync-race repair','SCRIPT','/scripts/repair-inspection-visit-official-pdf',$3,200)`,
      [found.rows[0].organization_id, found.rows[0].inspector_user_id, JSON.stringify({ visit_id: visitId, cleared: plan.changes.inspection_visits })],
    );
    await client.query('COMMIT');
    report.applied = true;
    report.dryRun = false;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Repair failed.');
    process.exitCode = 1;
    throw error;
  });
}
