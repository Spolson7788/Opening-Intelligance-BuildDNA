// M4: labels and filtering for the schedule vs field comparison page (pure, testable).
export type ComparisonCategory = "scheduled_not_surveyed" | "scheduled_opening_missing" | "not_in_schedule" | "field_mismatch" | "hardware_difference" | "open_follow_up";
export interface ComparisonLine { category: ComparisonCategory; mark: string | null; opening_id: string | null; opening_code: string | null; entity: string; field: string | null;
  schedule_value: string | null; field_value: string | null; note: string | null }
export interface ComparisonOpening { mark: string | null; source_row: number | null; opening_id: string | null; opening_code: string | null; floor_label: string | null;
  match: "mark" | "code" | null; surveyed: boolean; surveyed_at: string | null; surveyed_by_role: string | null;
  status: "matched" | "differences" | "not_surveyed" | "missing" | "not_in_schedule"; set_key: string | null; lines: ComparisonLine[] }

export const CATEGORY_LABEL: Record<ComparisonCategory, string> = {
  scheduled_not_surveyed: "Scheduled, not surveyed",
  scheduled_opening_missing: "Scheduled, opening missing",
  not_in_schedule: "In field, not in schedule",
  field_mismatch: "Field mismatch",
  hardware_difference: "Hardware difference",
  open_follow_up: "Open follow-up",
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL) as ComparisonCategory[];
export const STATUS_LABEL: Record<ComparisonOpening["status"], string> = {
  matched: "Matches schedule", differences: "Differences", not_surveyed: "Not surveyed", missing: "Missing", not_in_schedule: "Not in schedule",
};
export const MATCH_LABEL = (m: ComparisonOpening["match"]) => (m === "code" ? "matched by code" : m === "mark" ? "schedule mark" : "");

export interface ComparisonFilter { category?: ComparisonCategory | ""; surveyed?: "" | "yes" | "no"; field?: string; search?: string; floor?: string; onlyDifferences?: boolean }

/** Which field group a line belongs to (for the field filter). */
export function fieldGroup(l: ComparisonLine): string {
  if (l.entity === "hardware") return "hardware";
  const f = l.field ?? "";
  if (/width|height|thickness/.test(f)) return "size";
  if (/fire/.test(f)) return "fire";
  if (/material/.test(f)) return "material";
  if (/configuration/.test(f)) return "configuration";
  return "other";
}

export function filterOpenings(list: ComparisonOpening[], f: ComparisonFilter): ComparisonOpening[] {
  const q = (f.search ?? "").trim().toUpperCase();
  return list.map((o) => {
    if (f.surveyed === "yes" && !o.surveyed) return null;
    if (f.surveyed === "no" && o.surveyed) return null;
    if (f.floor && (o.floor_label ?? "") !== f.floor) return null;
    if (q && !`${o.mark ?? ""} ${o.opening_code ?? ""}`.toUpperCase().includes(q)) return null;
    let lines = o.lines;
    if (f.category) lines = lines.filter((l) => l.category === f.category);
    if (f.field) lines = lines.filter((l) => fieldGroup(l) === f.field);
    if (f.onlyDifferences) lines = lines.filter((l) => l.category === "field_mismatch" || l.category === "hardware_difference");
    if ((f.category || f.field || f.onlyDifferences) && !lines.length) return null;
    return { ...o, lines };
  }).filter((o): o is ComparisonOpening => o !== null);
}

export function floorsOf(list: ComparisonOpening[]): string[] {
  return [...new Set(list.map((o) => o.floor_label).filter((x): x is string => !!x))].sort();
}

export function comparisonErrorMessage(code: string): string {
  return code === "import_not_confirmed" ? "Only confirmed imports can be compared with the field."
    : code === "insufficient_role_for_action" ? "Your role cannot view schedule comparisons."
    : code === "comparisons_unavailable" ? "Schedule comparisons are not available yet on this server."
    : code === "not_found" ? "Comparison not found." : "Could not load the comparison. Nothing was changed.";
}