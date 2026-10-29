import type { PlatformOrganization } from "./api";

// M5 pure helpers for the staff tools (unit tested).
export function filterSort<T>(rows: T[], query: string, fields: (keyof T)[], sortKey: keyof T, dir: 1 | -1 = 1): T[] {
  const q = query.trim().toLowerCase();
  const hit = (r: T) => !q || fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q));
  return rows.filter(hit).sort((a, b) => {
    const x = a[sortKey] as unknown, y = b[sortKey] as unknown;
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x ?? "").localeCompare(String(y ?? "")) * dir;
  });
}

/** Valid parents: same type, not internal, not itself or one of its descendants. */
export function parentChoices(orgs: PlatformOrganization[], orgId: string): PlatformOrganization[] {
  const me = orgs.find((o) => o.id === orgId);
  if (!me || me.org_type === "internal") return [];
  const below = new Set<string>([orgId]);
  let grew = true;
  while (grew) { grew = false; for (const o of orgs) if (o.parent_organization_id && below.has(o.parent_organization_id) && !below.has(o.id)) { below.add(o.id); grew = true; } }
  return orgs.filter((o) => o.org_type === me.org_type && !below.has(o.id));
}
export const needsProviderConfirmation = (org: PlatformOrganization | undefined, parentId: string | null) => !!org && org.org_type === "service_partner" && !!parentId;

/** Tree lines ("  - name") for the whole tree that contains orgId, after a proposed change. */
export function treeLines(orgs: PlatformOrganization[], orgId: string, proposedParent?: string | null): string[] {
  const list = orgs.map((o) => o.id === orgId && proposedParent !== undefined ? { ...o, parent_organization_id: proposedParent } : o);
  const byId = new Map(list.map((o) => [o.id, o]));
  let top = byId.get(orgId); const seen = new Set<string>();
  while (top?.parent_organization_id && byId.has(top.parent_organization_id) && !seen.has(top.id)) { seen.add(top.id); top = byId.get(top.parent_organization_id); }
  if (!top) return [];
  const out: string[] = [];
  const walk = (id: string, depth: number) => {
    if (depth > 20) return;
    const o = byId.get(id)!; out.push("  ".repeat(depth) + "- " + o.name + (o.id === orgId ? "  <-" : ""));
    for (const c of list.filter((x) => x.parent_organization_id === id).sort((a, b) => a.name.localeCompare(b.name))) walk(c.id, depth + 1);
  };
  walk(top.id, 0);
  return out;
}
