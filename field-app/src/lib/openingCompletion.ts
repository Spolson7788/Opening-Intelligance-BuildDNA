export function openingCompletionRequirements(opening: any): string[] {
  const missing: string[] = [];
  if (!opening?.frame) missing.push("Save the frame");

  const leafRoles = new Set((opening?.door_leaves ?? []).map((leaf: any) => leaf.leaf_role));
  const leavesComplete = opening?.opening_configuration === "pair"
    ? leafRoles.has("active") && leafRoles.has("inactive")
    : leafRoles.has("single");
  if (!leavesComplete) missing.push(opening?.opening_configuration === "pair" ? "Save both door leaves" : "Save the door leaf");

  const hardware = opening?.hardware_components ?? [];
  if (hardware.length === 0) missing.push("Add at least one hardware component");
  else if (hardware.some((item: any) => item.review_state !== "reviewed")) missing.push("Review every hardware component");
  const assessed = (item: any) => ["good", "worn", "failed"].includes(item.condition);
  if (opening?.frame && !assessed(opening.frame)) missing.push("Assess the frame condition");
  if ((opening?.door_leaves ?? []).some((leaf: any) => !assessed(leaf))) missing.push("Assess every door leaf condition");
  if (hardware.some((item: any) => !assessed(item))) missing.push("Assess every hardware condition");
  return missing;
}
