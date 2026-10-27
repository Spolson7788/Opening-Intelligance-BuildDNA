// Keyword map from hardware schedule descriptions to component types, plus
// manufacturer aliases and finish handling. item_type keeps the rich type;
// component_type is the value allowed by hardware_components' CHECK.
export const ALLOWED_COMPONENT_TYPES = [
  "lockset", "cylinder", "closer", "exit_device", "hinge", "automatic_operator", "panic_bar",
  "access_control_reader", "keypad", "electric_strike", "power_transfer", "maglock",
  "request_to_exit_device", "other",
] as const;
export type ComponentType = (typeof ALLOWED_COMPONENT_TYPES)[number];

const RULES: [RegExp, string, ComponentType][] = [
  [/\bexit\s*device|\bpanic\s*device|\bcrash\s*bar/i, "exit_device", "exit_device"],
  [/\bpanic\s*bar|\bpush\s*bar/i, "panic_bar", "panic_bar"],
  [/\bflush\s*bolt|\bsurface\s*bolt/i, "flush_bolt", "other"],
  [/\bhold[\s-]*open|\bdoor\s*holder|\bmagnetic\s*holder/i, "hold_open", "other"],
  [/\bmag(netic)?\s*lock|\bmaglock|\belectromagnetic\s*lock/i, "maglock", "maglock"],
  [/\belectric\s*strike|\be-?strike/i, "electric_strike", "electric_strike"],
  [/\bauto(matic)?\s*(door\s*)?operator|\bpower\s*operator/i, "automatic_operator", "automatic_operator"],
  [/\bcloser\b/i, "closer", "closer"],
  [/\bcard\s*reader|\bproximity\s*reader|\breader\b/i, "access_control_reader", "access_control_reader"],
  [/\bkey\s*pad|\bkeypad/i, "keypad", "keypad"],
  [/\brequest\s*to\s*exit|\brex\b|\bmotion\s*sensor/i, "request_to_exit_device", "request_to_exit_device"],
  [/\bpower\s*transfer|\belectric\s*hinge|\bep\s*hinge/i, "power_transfer", "power_transfer"],
  [/\bdead\s*bolt|\bdeadlock/i, "deadbolt", "lockset"],
  [/\bcylinder\b|\bcore\b/i, "cylinder", "cylinder"],
  [/\b(outside|exit|entrance|entry|lever)\s*trim|\bescutcheon|\btrim\b/i, "exit_trim", "other"],
  [/\block(set)?\b|\blatch(set)?\b|\bpassage\b|\bprivacy\b|\bstoreroom\b|\bclassroom\b|\bentry\s*(set|function)|\bdummy\b|\blever\b|\bknob\b/i, "lockset", "lockset"],
  [/\bhinges?\b|\bpivot/i, "hinge", "hinge"],
  [/\b(wall|floor|door|overhead)\s*stop|\bstop\b|\bbumper/i, "stop", "other"],
  [/\b(kick|mop|armor|protection)\s*plate|\bkickplate/i, "protection_plate", "other"],
  [/\bthreshold|\bsaddle/i, "threshold", "other"],
  [/\bsweep|\bdoor\s*shoe|\bgasket|\bweather\s*strip|\bseal(s)?\b|\bdrip\b|\bsilencer|\bastragal|\bsmoke\s*seal/i, "seal", "other"],
  [/\bpull\b|\bpush\s*plate/i, "pull_push", "other"],
  [/\broller\s*catch|\bball\s*catch|\bcatch\b/i, "catch", "other"],
  [/\bviewer\b|\bpeep\s*hole|\bknocker/i, "viewer", "other"],
  [/\bstrike\b/i, "strike", "other"],
  [/\bkey\s*switch|\bwall\s*switch|\bpush\s*button|\bdoor\s*position\s*switch|\bdps\b|\bpower\s*supply|\bdoor\s*contact/i, "access_control_other", "other"],
  [/\bbarn\s*door|\bpocket\s*door|\btrack\b|\bsliding/i, "sliding_hardware", "other"],
];

export function classifyItem(description: string): { item_type: string; component_type: ComponentType; matched: boolean } {
  for (const [re, item, ct] of RULES) if (re.test(description)) return { item_type: item, component_type: ct, matched: true };
  return { item_type: "unclassified", component_type: "other", matched: false };
}

const MANUFACTURERS: Record<string, string[]> = {
  "Cal-Royal": ["CAL-ROYAL", "CAL ROYAL", "CALROYAL", "CR"],
  "Johnson Hardware": ["JOHNSON", "JOHNSON HARDWARE", "JH"],
  "Trimco": ["TRIMCO", "TRI"],
  "Adams Rite": ["ADAMS RITE", "ADAMS-RITE", "ADAMSRITE", "AR"],
  "SDC (Security Door Controls)": ["SDC", "SECURITY DOOR CONTROLS"],
  "Schlage": ["SCHLAGE", "SCH"],
  "LCN": ["LCN"],
  "Von Duprin": ["VON DUPRIN", "VONDUPRIN", "VD"],
  "Ives": ["IVES", "IVE"],
  "Hager": ["HAGER", "HAG"],
  "McKinney": ["MCKINNEY", "MCK"],
  "Stanley": ["STANLEY", "STA"],
  "Norton": ["NORTON", "NOR"],
  "Sargent": ["SARGENT", "SAR"],
  "Corbin Russwin": ["CORBIN RUSSWIN", "CORBIN", "RUS"],
  "Yale": ["YALE", "YAL"],
  "Rockwood": ["ROCKWOOD", "ROC"],
  "Glynn-Johnson": ["GLYNN-JOHNSON", "GLYNN JOHNSON", "GLY"],
  "Pemko": ["PEMKO", "PEM"],
  "National Guard Products": ["NATIONAL GUARD", "NGP"],
  "Zero International": ["ZERO", "ZERO INTERNATIONAL", "ZER"],
  "Folger Adam": ["FOLGER ADAM", "FOL"],
  "HES": ["HES"],
  "Precision": ["PRECISION", "PHI"],
  "Detex": ["DETEX", "DET"],
  "Allegion": ["ALLEGION"],
  "ASSA ABLOY": ["ASSA ABLOY", "ASSA"],
  "dormakaba": ["DORMAKABA", "DORMA", "KABA", "BEST", "BES"],
};
const ALIAS = new Map<string, string>();
for (const [canon, list] of Object.entries(MANUFACTURERS)) for (const a of [canon.toUpperCase(), ...list]) ALIAS.set(a.replace(/[.,]/g, ""), canon);

export function canonicalManufacturer(raw: string | null): string | null {
  if (!raw) return null;
  return ALIAS.get(raw.toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim()) ?? null;
}

/** US-designation to BHMA code where unambiguous. Unknown tokens stay as written. */
const BHMA: Record<string, string> = {
  US3: "605", US4: "606", US10: "612", US10B: "613", US10BE: "613E", US14: "618", US15: "619", US19: "622",
  US26: "625", US26D: "626", US28: "628", US32: "629", US32D: "630", "630": "630", "626": "626", "613": "613", "689": "689",
};
const FINISH_TOKEN = /^(?:US\d{1,2}[A-Z]{0,2}|[.]?6\d\d[A-Z]?|DURO|DKB|BLK|ORB|BHMA\d+|SP\d+|[-.]\d{3}[A-Z]?)$/i;
const OPTION_TOKEN = /^(NRP|RHR|LHR|RH|LH|SNB|TB|CVR|HT|RHRA|LHRA)$/i;

export function splitFinish(catalogRaw: string | null): { catalog: string | null; finish: string | null; finish_bhma: string | null; options: string | null } {
  const s = (catalogRaw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { catalog: null, finish: null, finish_bhma: null, options: null };
  const tokens = s.split(" ");
  const options: string[] = [];
  while (tokens.length > 1 && OPTION_TOKEN.test(tokens[tokens.length - 1])) options.unshift(tokens.pop()!);
  let finish: string | null = null;
  if (tokens.length > 1 && FINISH_TOKEN.test(tokens[tokens.length - 1])) finish = tokens.pop()!;
  else {
    // Finish glued to the catalog number: 1870-30-313 or 4040XP.689
    const last = tokens[tokens.length - 1];
    const m = /^(.+)-([36]\d\d[A-Z]?)$/i.exec(last) ?? /^(.+)\.(\d{3}[A-Z]?|US\d{1,2}[A-Z]{0,2})$/i.exec(last);
    if (m) { tokens[tokens.length - 1] = m[1]; finish = m[2]; }
  }
  const norm = finish ? finish.replace(/^[-.]/, "").toUpperCase() : null;
  return { catalog: tokens.join(" ") || null, finish: norm, finish_bhma: norm ? BHMA[norm] ?? null : null, options: options.length ? options.join(" ") : null };
}

/** Non-catalog text in the catalog column: BY DOOR SUPPLIER, AS REQUIRED BY HARDWARE, PER SILL DETAIL. */
export function furnishedByText(catalogRaw: string | null): string | null {
  const s = (catalogRaw ?? "").trim();
  return /^(BY\s|AS\s+REQUIRED|PER\s|FURNISHED\s+BY|N\.?I\.?C|BY OTHERS|EXISTING)/i.test(s) ? s.toUpperCase() : null;
}
