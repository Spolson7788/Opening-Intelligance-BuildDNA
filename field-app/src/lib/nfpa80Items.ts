// Same 13 keys the API requires. Wording is ours, with NFPA 80 (2022) section numbers.
export const NFPA80_ITEMS = [
  { key: "labels", section: "5.2.3.1", text: "The fire door and frame labels are in place and can be read." },
  { key: "holes_breaks", section: "5.2.3.2", text: "The door and frame have no open holes or breaks in their surfaces." },
  { key: "glazing", section: "5.2.3.3", text: "Glazing and the frames that hold it are intact." },
  { key: "secure_aligned", section: "5.2.3.4", text: "The door, frame, hinges, hardware, and any noncombustible threshold are secure, aligned, and in working order." },
  { key: "parts", section: "5.2.3.5", text: "No required parts are missing or broken." },
  { key: "clearances", section: "5.2.3.6", text: "Clearances are within the limit used for this inspection: the gap under the door is not over 3/4 inch, and the top and side gaps meet the clearance rule for this door." },
  { key: "self_closing", section: "5.2.3.7", text: "The door closes itself all the way from the open position." },
  { key: "coordinator", section: "5.2.3.8", text: "On a pair of doors, the coordinator lets the inactive leaf close before the active leaf. Use N/A when there is no coordinator." },
  { key: "latching", section: "5.2.3.9", text: "The latching hardware holds the door positively latched." },
  { key: "hold_open", section: "5.2.3.10", text: "No hold-open device is installed unless it is a listed releasing device." },
  { key: "field_modifications", section: "5.2.3.11", text: "No field change that affects the fire rating was made without a documented approval." },
  { key: "gasketing", section: "5.2.3.12", text: "Gasketing and edge seals, where this door has them, are in place and not damaged. Use N/A when the door has none." },
  { key: "signage", section: "5.2.3.13", text: "Signs on the door meet the attachment and coverage limits for a fire door." },
] as const;
