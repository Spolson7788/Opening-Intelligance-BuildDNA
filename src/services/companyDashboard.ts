// Company dashboard reads. No new tables. Facility accounts are customer sites
// granted to this provider. Provider-owned sites are split with a name check
// until account kind is stored: a name containing "walk-in" is the Walk-in
// list, and every other provider-owned site is a Small account.

export const COMPANY_DASHBOARD_ROLES = new Set(["admin", "facilities_manager"]);

export const COMPANY_DASHBOARD_REFUSAL =
  "Company administrators and managers use this dashboard. Technicians and inspectors use the field app.";

export const ACCOUNT_KIND_NOTE =
  "Account kind is stored for each site. Facility accounts are sites a customer has granted. Provider-owned sites are Small accounts, except a name containing Walk-in, which belongs to that company's one Walk-in bucket.";

export type AccountKind = "facility" | "small" | "walkin";

export function mayOpenCompanyDashboard(role: unknown): boolean {
  return COMPANY_DASHBOARD_ROLES.has(String(role));
}

export function accountKind(isOwner: boolean, siteName: string): AccountKind {
  if (!isOwner) return "facility";
  return /\bwalk[-\s]?in\b/i.test(siteName) ? "walkin" : "small";
}

export function resolveAccountKind(site: { storedKind?: string | null; isOwner: boolean; name: string }): AccountKind {
  if (site.storedKind === "facility" || site.storedKind === "small" || site.storedKind === "walkin") return site.storedKind;
  return accountKind(site.isOwner, site.name);
}

export function accountKindLabel(kind: AccountKind): string {
  if (kind === "facility") return "Facility account";
  if (kind === "walkin") return "Walk-in";
  return "Small account";
}

export function customerKey(kind: AccountKind, ownerId: string, propertyId: string): string {
  if (kind === "facility") return ownerId;
  if (kind === "walkin") return `walkin:${propertyId}`;
  return `small:${propertyId}`;
}

export function attentionText(count: number): string {
  if (count <= 0) return "Nothing waiting";
  if (count === 1) return "1 needs attention";
  return `${count} need attention`;
}

export interface SiteRollup {
  id: string;
  name: string;
  address: string;
  isOwner: boolean;
  ownerId: string;
  ownerName: string;
  storedKind?: AccountKind | null;
  accountId?: string | null;
  accountName?: string | null;
  openingCount: number;
  attentionCount: number;
  lastVisit: string | null;
  nextDue: string | null;
}

export interface CustomerRow {
  id: string;
  name: string;
  kind: AccountKind;
  kind_label: string;
  opening_count: number;
  attention_count: number;
  attention: string;
  last_visit: string | null;
  next_due: string | null;
  property_ids: string[];
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function sooner(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function groupCustomers(sites: SiteRollup[]): CustomerRow[] {
  const grouped = new Map<string, CustomerRow>();
  for (const site of sites) {
    const kind = resolveAccountKind(site);
    const groupId = kind === "facility" ? site.ownerId : (site.accountId || site.id);
    const id = customerKey(kind, site.ownerId, groupId);
    const name = kind === "facility"
      ? site.ownerName
      : kind === "walkin"
        ? (site.accountName || (site.accountId ? "Walk-in" : site.name))
        : (site.accountName || site.name);
    const existing = grouped.get(id);
    if (!existing) {
      grouped.set(id, {
        id,
        name,
        kind,
        kind_label: accountKindLabel(kind),
        opening_count: site.openingCount,
        attention_count: site.attentionCount,
        attention: attentionText(site.attentionCount),
        last_visit: site.lastVisit,
        next_due: site.nextDue,
        property_ids: [site.id],
      });
      continue;
    }
    existing.opening_count += site.openingCount;
    existing.attention_count += site.attentionCount;
    existing.attention = attentionText(existing.attention_count);
    existing.last_visit = later(existing.last_visit, site.lastVisit);
    existing.next_due = sooner(existing.next_due, site.nextDue);
    existing.property_ids.push(site.id);
  }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
}
