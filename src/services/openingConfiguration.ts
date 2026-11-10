import type { PoolClient } from "pg";

export type OpeningConfiguration = "single" | "pair";

/** Change single/pair by renaming leaf roles. Leaf ids stay, so hardware and photos keep their target. */
export async function convertOpeningConfiguration(client: PoolClient, openingId: string, next: OpeningConfiguration) {
  if (next === "pair") {
    await client.query(
      `UPDATE door_leaves SET leaf_role='active', updated_at=now()
       WHERE opening_id=$1 AND leaf_role='single'
         AND NOT EXISTS (SELECT 1 FROM door_leaves other WHERE other.opening_id=$1 AND other.leaf_role='active')`,
      [openingId],
    );
    const inactive = await client.query("SELECT id FROM door_leaves WHERE opening_id=$1 AND leaf_role='inactive'", [openingId]);
    if (!inactive.rows[0]) {
      await client.query(
        "INSERT INTO door_leaves (opening_id, leaf_role, condition) VALUES ($1, 'inactive', 'unverified')",
        [openingId],
      );
    }
  } else {
    await client.query(
      `UPDATE door_leaves SET leaf_role='single', updated_at=now()
       WHERE opening_id=$1 AND leaf_role='active'
         AND NOT EXISTS (SELECT 1 FROM door_leaves other WHERE other.opening_id=$1 AND other.leaf_role='single')`,
      [openingId],
    );
  }
  const opening = await client.query(
    "UPDATE openings SET opening_configuration=$2, updated_at=now() WHERE id=$1 RETURNING *",
    [openingId, next],
  );
  const leaves = await client.query(
    "SELECT * FROM door_leaves WHERE opening_id=$1 ORDER BY CASE leaf_role WHEN 'single' THEN 0 WHEN 'active' THEN 1 ELSE 2 END",
    [openingId],
  );
  return { opening: opening.rows[0], door_leaves: leaves.rows };
}
