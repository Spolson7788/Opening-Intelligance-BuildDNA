// OI staff shut off one company the way a company admin deactivates a person who leaves.
// Memberships of that company are turned off and every one of those people's current
// tokens is rejected on the next request. Rows are updated, never deleted.
// Other companies' provider assignments and parent-tree access are not changed.

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export class CompanyDeactivationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function lockedCompany(db: Db, organizationId: string) {
  const org = (await db.query(
    "SELECT id, name, org_type, deactivated_at FROM organizations WHERE id=$1 FOR UPDATE",
    [organizationId],
  )).rows[0];
  if (!org) throw new CompanyDeactivationError(404, "organization_not_found");
  return org;
}

function refuseInternal(org: { id: string; org_type: string }, actorOrgId: string) {
  if (org.org_type === "internal" || org.id === actorOrgId) {
    throw new CompanyDeactivationError(400, "cannot_deactivate_internal_company");
  }
}

async function audit(db: Db, input: {
  actorId: string; actorOrgId: string; organizationId: string; action: string; reason: string;
  before: Record<string, unknown>; after: Record<string, unknown>; path: string; method: string;
}) {
  await db.query(
    `INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
    [input.actorId, input.actorOrgId, input.action, input.organizationId, input.reason, JSON.stringify(input.before), JSON.stringify(input.after)],
  );
  await db.query(
    `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code)
     VALUES ($1,$2,$3,$4,$5,$6,200)`,
    [input.organizationId, input.actorId, input.action, input.method, input.path, JSON.stringify({ reason: input.reason, before: input.before, after: input.after })],
  );
}

export async function deactivateCompany(db: Db, input: { actorId: string; actorOrgId: string; organizationId: string; reason: string }) {
  const org = await lockedCompany(db, input.organizationId);
  refuseInternal(org, input.actorOrgId);
  if (org.deactivated_at) throw new CompanyDeactivationError(409, "company_already_deactivated");
  await db.query("SELECT set_config('oi.company_deactivation','on',true)");
  const members = await db.query(
    `INSERT INTO organization_deactivation_memberships (organization_id, user_id, was_active)
     SELECT organization_id, user_id, true FROM organization_memberships
     WHERE organization_id=$1 AND is_active
     RETURNING user_id`,
    [org.id],
  );
  await db.query(
    `UPDATE organization_memberships
     SET is_active=false, deactivated_at=now(), deactivated_by_user_id=$2, deactivation_reason=$3
     WHERE organization_id=$1 AND is_active`,
    [org.id, input.actorId, input.reason],
  );
  const sessions = await db.query(
    `UPDATE users SET session_version = session_version + 1
     WHERE id IN (SELECT user_id FROM organization_memberships WHERE organization_id=$1)
     RETURNING id`,
    [org.id],
  );
  await db.query(
    "UPDATE organizations SET deactivated_at=now(), deactivated_by_user_id=$2, deactivation_reason=$3 WHERE id=$1",
    [org.id, input.actorId, input.reason],
  );
  const after = {
    deactivated: true,
    memberships_deactivated: members.rowCount ?? members.rows.length,
    sessions_revoked: sessions.rowCount ?? sessions.rows.length,
    assignments_unchanged: true,
  };
  await audit(db, {
    actorId: input.actorId, actorOrgId: input.actorOrgId, organizationId: org.id,
    action: "company_deactivated", reason: input.reason, path: "/api/platform/organizations/" + org.id + "/deactivate", method: "POST",
    before: { deactivated: false, org_type: org.org_type }, after,
  });
  return { id: org.id, name: org.name, ...after };
}

export async function reactivateCompany(db: Db, input: { actorId: string; actorOrgId: string; organizationId: string; reason: string }) {
  const org = await lockedCompany(db, input.organizationId);
  refuseInternal(org, input.actorOrgId);
  if (!org.deactivated_at) throw new CompanyDeactivationError(409, "company_not_deactivated");
  const restored = await db.query(
    `UPDATE organization_memberships m
     SET is_active=true, deactivated_at=NULL, deactivated_by_user_id=NULL, deactivation_reason=NULL
     FROM organization_deactivation_memberships s
     WHERE s.organization_id=m.organization_id AND s.user_id=m.user_id AND s.organization_id=$1 AND s.was_active
     RETURNING m.user_id`,
    [org.id],
  );
  await db.query("DELETE FROM organization_deactivation_memberships WHERE organization_id=$1", [org.id]);
  await db.query(
    `UPDATE users SET session_version = session_version + 1
     WHERE id IN (SELECT user_id FROM organization_memberships WHERE organization_id=$1)`,
    [org.id],
  );
  await db.query(
    "UPDATE organizations SET deactivated_at=NULL, deactivated_by_user_id=NULL, deactivation_reason=NULL WHERE id=$1",
    [org.id],
  );
  const after = { deactivated: false, memberships_restored: restored.rowCount ?? restored.rows.length };
  await audit(db, {
    actorId: input.actorId, actorOrgId: input.actorOrgId, organizationId: org.id,
    action: "company_reactivated", reason: input.reason, path: "/api/platform/organizations/" + org.id + "/reactivate", method: "POST",
    before: { deactivated: true }, after,
  });
  return { id: org.id, name: org.name, ...after };
}
