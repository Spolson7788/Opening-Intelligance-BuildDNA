import { Response } from "express";

const CONFLICTS = new Set([
  "out_of_area",
  "assignment_would_be_out_of_area",
  "area_change_would_uncover_assignment",
]);

const CHECKS = [
  "out_of_area",
  "assignment_would_be_out_of_area",
  "area_change_would_uncover_assignment",
  "county_not_in_state",
  "provider_org_required",
  "branch_not_in_provider",
  "technician_area_user_required",
  "user_branch_org_mismatch",
];

// Maps database check failures onto API errors. Returns true when it sent
// the response, so the caller can stop.
export function respondToConstraint(res: Response, err: { code?: string; message?: string }): boolean {
  if (err?.code === "23505") {
    res.status(409).json({ error: "already_exists" });
    return true;
  }
  if (err?.code === "23503") {
    res.status(400).json({ error: "invalid_reference" });
    return true;
  }
  if (err?.code === "23514") {
    // Longest match first: "assignment_would_be_out_of_area" contains "out_of_area".
    const message = String(err.message);
    const hit = [...CHECKS].sort((a, b) => b.length - a.length).find((name) => message.includes(name));
    if (hit) {
      res.status(CONFLICTS.has(hit) ? 409 : 400).json({ error: hit });
      return true;
    }
  }
  return false;
}
