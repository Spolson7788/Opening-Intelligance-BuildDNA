// M5: who may add whom. Decision (Stephan, 2026-10-28): ADMINS ONLY add people, and
// nobody can create a role above their own.
export const ROLES = ["admin", "facilities_manager", "technician", "inspector", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { admin: 4, facilities_manager: 3, technician: 2, inspector: 2, viewer: 1 };
export const MEMBER_CREATOR_ROLES: readonly string[] = ["admin"];
export function canCreateRole(creatorRole: string, targetRole: string): { ok: true } | { ok: false; error: "admin_required" | "role_above_creator" | "invalid_role" } {
  if (!(ROLES as readonly string[]).includes(targetRole)) return { ok: false, error: "invalid_role" };
  if (!MEMBER_CREATOR_ROLES.includes(creatorRole)) return { ok: false, error: "admin_required" };
  const c = ROLE_RANK[creatorRole as Role] ?? 0, t = ROLE_RANK[targetRole as Role];
  return t > c ? { ok: false, error: "role_above_creator" } : { ok: true };
}
/** Passwords: 12 to 72 UTF-8 bytes (bcrypt limit), same as account recovery. */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string") return "password_required";
  const bytes = Buffer.byteLength(p, "utf8");
  if (bytes < 12) return "password_too_short";
  if (bytes > 72) return "password_too_long";
  return null;
}
export const INVITE_TTL_DAYS = 7;
export const INVITE_LIMITS = { orgSendsPerHour: 30, inviteCooldownSeconds: 60, inviteSendsPerDay: 5 };