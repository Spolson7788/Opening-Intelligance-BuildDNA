// Company dashboard reads. No new tables. Facility accounts are customer sites
// granted to this provider. Provider-owned sites are split with a name check
// until account kind is stored: a name containing "walk-in" is the Walk-in
// list, and every other provider-owned site is a Small account.

export const COMPANY_DASHBOARD_ROLES = new Set(["admin", "facilities_manager"]);

export const COMPANY_DASHBOARD_REFUSAL =
  "Company administrators and managers use this dashboard. Technicians and inspectors use the field app.";

export const ACCOUNT_KIND_NOTE =
  "Facility accounts are sites a customer has granted. A site this company owns is Walk-in when its name contains Walk-in, and a Small account otherwise.";

export type AccountKind = "facility" | "small" | "walkin";

export function mayOpenCompanyDashboard(role: unknown): boolean {
  return COMPANY_DASHBOARD_ROLES.has(String(role));
}

export function accountKind(isOwner: boolean, siteName: string): AccountKind {
  if (!isOwner) return "facility";
  return /\bwalk[-\s]?in\b/i.test(siteName) ? "walkin" : "small";
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
  const facility = new Map<string, CustomerRow>();
  const rows: CustomerRow[] = [];
  for (const site of sites) {
    const kind = accountKind(site.isOwner, site.name);
    if (kind !== "facility") {
      rows.push({
        id: customerKey(kind, site.ownerId, site.id),
        name: site.name,
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
    const existing = facility.get(site.ownerId);
    if (!existing) {
      facility.set(site.ownerId, {
        id: site.ownerId,
        name: site.ownerName,
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
  return [...facility.values(), ...rows].sort((a, b) => a.name.localeCompare(b.name));
}
