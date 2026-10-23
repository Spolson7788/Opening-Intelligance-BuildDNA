/** A missing revision is valid only for a new record, never an overwrite. */
export function revisionConflict(current: { revision: string | number } | undefined, expected: number | null | undefined) {
  if (!current && expected == null) return null;
  if (current && expected != null && Number(current.revision) === expected) return null;
  return { error: "revision_conflict", server_revision: current ? Number(current.revision) : null,
    expected_revision: expected ?? null };
}
