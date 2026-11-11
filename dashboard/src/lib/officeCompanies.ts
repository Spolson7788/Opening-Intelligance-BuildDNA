import type { CompanyChoice } from "./api";

const OFFICE = new Set(["admin", "facilities_manager"]);

/** Companies this person may open on the company dashboard. Same membership list as the sidebar switcher, limited to an active office role. */
export function officeCompanies(list: CompanyChoice[]): CompanyChoice[] {
  const seen = new Map<string, CompanyChoice>();
  for (const company of list) {
    if (!OFFICE.has(company.role)) continue;
    const current = seen.get(company.organization_id);
    if (!current || company.is_home) seen.set(company.organization_id, company);
  }
  return [...seen.values()];
}
