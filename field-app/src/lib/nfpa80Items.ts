// Same 13 keys the API requires. NFPA 80 (2025) 5.2.4.2. Wording is ours.
export const NFPA80_ITEMS = [
  { key: "labels", section: "5.2.4.2(1)", text: "The labels on the fire door and frame are in place and can be read." },
  { key: "holes_breaks", section: "5.2.4.2(2)", text: "The door and frame have no open holes or breaks in their surfaces." },
  { key: "glazing", section: "5.2.4.2(3)", text: "Any glazing, the frames around it, and the beads that hold it are intact and fastened." },
  { key: "secure_aligned", section: "5.2.4.2(4)", text: "The door, frame, hinges, hardware, and any noncombustible threshold are secure, aligned, and working, with no obvious damage." },
  { key: "parts", section: "5.2.4.2(5)", text: "No required parts are missing or broken." },
  { key: "clearances", section: "5.2.4.2(6)", text: "Gaps meet the clearance rule for this door. The gap under the door is not over 3/4 inch, or 3/8 inch when the bottom of the door sits more than 38 inches above the finished floor. A listed product made to close a larger bottom gap is acceptable. Top and side gaps stay within the limit for this door." },
  { key: "self_closing", section: "5.2.4.2(7)", text: "From fully open, the door closes all the way by itself, or a listed automatic closer releases it so it can. A wedge or other block holding it open is not acceptable." },
  { key: "coordinator", section: "5.2.4.2(8)", text: "On a pair, the coordinator lets the inactive leaf close before the active leaf. Use N/A when there is no coordinator." },
  { key: "latching", section: "5.2.4.2(9)", text: "The latching hardware holds the door positively latched when it is closed." },
  { key: "hold_open", section: "5.2.4.2(10)", text: "Nothing added to the door or frame stops it from opening, closing, or latching. That includes a hold-open that is not a listed releasing device." },
  { key: "field_modifications", section: "5.2.4.2(11)", text: "No field change was made that voids the fire door listing." },
  { key: "gasketing", section: "5.2.4.2(12)", text: "Gasketing, meeting-edge protection, and edge seals, where this door has them, are present and intact. Use N/A when the door has none." },
  { key: "signage", section: "5.2.4.2(13)", text: "Signs on the door stay within the size and attachment limits for a fire door and are not placed on the glazing." },
] as const;
