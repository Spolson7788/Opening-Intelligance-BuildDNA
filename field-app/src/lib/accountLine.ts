import type { CompanyOption } from "./companySwitch";

export function companyOptionLabel(company: CompanyOption): string {
  const name = company.name?.trim();
  return (name || "Unnamed company") + (company.access === "tree_view" ? " (view only)" : "");
}

export function activeCompanyName(companies: CompanyOption[], organizationId: string): string {
  const match = companies.find((company) => company.organization_id === organizationId);
  return match ? companyOptionLabel(match) : "Company name unavailable";
}

export function signedInLabel(email: string | null | undefined, userId: string): string {
  return email?.trim() || `Account ${userId}`;
}
