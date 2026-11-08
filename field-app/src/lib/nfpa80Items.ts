// Same 13 keys the API requires. NFPA 80 (2025) 5.2.4.2. Wording is ours.
// allowsNa is false for items every swinging fire door has: 5.2.4.2 (1), (2),
// (4), (5), (6), (7), (9), (10), and (11). N/A is only for (3), (8), (12), and (13).
export const NFPA80_ITEMS = [
  { key: "labels", section: "5.2.4.2(1)", allowsNa: false, text: "The labels on the fire door and frame are in place and can be read." },
  { key: "holes_breaks", section: "5.2.4.2(2)", allowsNa: false, text: "The door and frame have no open holes or breaks in their surfaces." },
  { key: "glazing", section: "5.2.4.2(3)", allowsNa: true, text: "Any glazing, the frames around it, and the beads that hold it are intact and fastened. Use N/A when this door has no glazing." },
  { key: "secure_aligned", section: "5.2.4.2(4)", allowsNa: false, text: "The door, frame, hinges, hardware, and any noncombustible threshold are secure, aligned, and working, with no obvious damage." },
  { key: "parts", section: "5.2.4.2(5)", allowsNa: false, text: "No required parts are missing or broken." },
  // based on public summaries; confirm against licensed NFPA 80 2025 text
  { key: "clearances", section: "5.2.4.2(6)", allowsNa: false, text: "The gap at the head and each jamb is not over 1/8 inch. The gap under the door is not over 3/4 inch, or 3/8 inch when the bottom of the door sits more than 38 inches above the finished floor. A listed product made to close a larger bottom gap is acceptable." },
  { key: "self_closing", section: "5.2.4.2(7)", allowsNa: false, text: "From fully open, the door closes all the way by itself, or a listed automatic closer releases it so it can. A wedge or other block holding it open is not acceptable." },
  { key: "coordinator", section: "5.2.4.2(8)", allowsNa: true, text: "On a pair, the coordinator lets the inactive leaf close before the active leaf. Use N/A when there is no coordinator." },
  { key: "latching", section: "5.2.4.2(9)", allowsNa: false, text: "The latching hardware holds the door positively latched when it is closed." },
  { key: "hold_open", section: "5.2.4.2(10)", allowsNa: false, text: "Nothing added to the door or frame stops it from opening, closing, or latching. That includes a hold-open that is not a listed releasing device." },
  { key: "field_modifications", section: "5.2.4.2(11)", allowsNa: false, text: "No field change was made that voids the fire door listing." },
  { key: "gasketing", section: "5.2.4.2(12)", allowsNa: true, text: "Gasketing, meeting-edge protection, and edge seals, where this door has them, are present and intact. Use N/A when the door has none." },
  // based on public summaries; confirm against licensed NFPA 80 2025 text
  { key: "signage", section: "5.2.4.2(13)", allowsNa: true, text: "Signs cover no more than 5% of the door face, are not placed on the glazing, and are not held on with fasteners that go through the door. Use N/A when this door has no sign." },
] as const;

export function checklistStarted(answers: Record<string, { result?: string } | undefined>): boolean {
  return Object.values(answers).some((answer) => answer?.result === "pass" || answer?.result === "fail" || answer?.result === "na");
}

// A started checklist is a fire door inspection even if the type selector
// has fallen back to its first option.
export function resolveInspectionType(selected: string, answers: Record<string, { result?: string } | undefined>): string {
  return checklistStarted(answers) || selected === "fire_door_nfpa80" ? "fire_door_nfpa80" : selected;
}

export function fireDoorOutcome(answers: Record<string, { result?: string } | undefined>): { ok: true; passed: boolean } | { ok: false; error: string } {
  for (const item of NFPA80_ITEMS) {
    const result = answers[item.key]?.result;
    if (result !== "pass" && result !== "fail" && result !== "na") {
      return { ok: false, error: "Answer every fire door item before saving." };
    }
    if (!item.allowsNa && result === "na") {
      return { ok: false, error: "Labels, surfaces, the assembly, parts, clearances, self-closing, latching, added hardware, and field changes must be pass or fail. N/A does not complete the inspection." };
    }
  }
  const coreAnswered = NFPA80_ITEMS.some((item) => !item.allowsNa && (answers[item.key]?.result === "pass" || answers[item.key]?.result === "fail"));
  if (!coreAnswered) return { ok: false, error: "An inspection with every item marked N/A is incomplete, not a pass." };
  return { ok: true, passed: !NFPA80_ITEMS.some((item) => answers[item.key]?.result === "fail") };
}
