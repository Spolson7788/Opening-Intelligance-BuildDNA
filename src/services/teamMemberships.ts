// Multi-company milestone 2: team management on organization_memberships.
// - Every change targets ONE stated company: the caller's active company.
// - Removing someone from a non-home company ends only that membership.
// - Deactivating a person (from their HOME company) deactivates them everywhere (DB trigger).
// - Reactivation restores the home membership only; other companies must add the person again.
// - Every change bumps session_version (old tokens: 401 session_revoked) and is recorded in
//   user_history (who, when, why, before/after) plus platform_audit_events and audit_log.
// No password hashes are read or returned.
export const HISTORY_DEFAULT_REASON = "Changed by company admin";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function membershipOf(db: Db, userId: string, orgId: string, lock = false) {
  const r = await db.query(
    `SELECT m.user_id, m.organization_id, m.role, m.is_active, m.is_home, u.is_active AS person_active, u.email, u.full_name
     FROM organization_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = $1 AND m.organization_id = $2${lock ? " FOR UPDATE OF m" : ""}`, [userId, orgId]);
  return r.rows[0] ?? null;
}

export async function activeAdminCount(db: Db, orgId: string) {
  return (await db.query(`SELECT count(*)::int AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id AND u.is_active
    WHERE m.organization_id = $1 AND m.is_active AND m.role = 'admin'`, [orgId])).rows[0].n as number;
}

export async function record(db: Db, a: { actor: string; orgId: string; target: string; change: "deactivate" | "reactivate" | "role_change";
  action: string; reason: string; before: Record<string, unknown>; after: Record<string, unknown>; path: string; method: string }) {
  if (a.actor !== a.target) {
    await db.query(`INSERT INTO user_history (user_id, organization_id, changed_by_user_id, change, reason, before_state, after_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [a.target, a.orgId, a.actor, a.change, a.reason, JSON.stringify(a.before), JSON.stringify(a.after)]);
  }
  await db.query(`INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
    VALUES ($1,$2,$3,$2,$4,$5,$6,$7)`, [a.actor, a.orgId, a.action, a.target, a.reason, JSON.stringify(a.before), JSON.stringify(a.after)]);
  await db.query(`INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code) VALUES ($1,$2,$3,$4,$5,$6,200)`,
    [a.orgId, a.actor, a.action, a.method, a.path, JSON.stringify({ user_id: a.target, reason: a.reason, before: a.before, after: a.after })]);
}
