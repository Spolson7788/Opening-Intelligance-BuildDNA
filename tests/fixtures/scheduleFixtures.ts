import { strToU8, zipSync } from "fflate";

// Synthetic fixtures mirroring the structure (not the content) of the real
// Revit door schedule export and Word hardware schedule. Every known sample
// problem is reproduced with invented rooms, marks and values.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i: number) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

export function buildXlsx(rows: (string | number | null)[][], merges: string[] = [], sheetName = "Table 1"): Uint8Array {
  const strings: string[] = []; const idx = new Map<string, number>();
  const sid = (s: string) => { if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); } return idx.get(s)!; };
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
    if (v === null || v === "") return "";
    const ref = `${col(ci)}${ri + 1}`;
    return typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
  }).join("") + "</row>").join("");
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData>${mergeXml}</worksheet>`),
  });
}

const HEAD1 = ["ROOM NAME AND NUMBER", "MARK", "TYPE MARK", "DOOR SIZE", "", "", "DESCRIPTION", "EL_Type Mark_SP", "FRAME MATERIAL", "EL_HW\nGroup_SP", "EL_Closer Type_SP", "FIRE RATING", "COMM MENTS", "To Room: Name"];
const HEAD2 = ["", "", "", "WIDTH", "HEIGHT", "THICKNESS", "", "", "", "", "", "", "", ""];
const door = (room: string, mark: string | number, type: string, w: string, h: string, desc: string, mat: string, hw: string, closer: string, fire: string, to: string) =>
  [room, mark, type, w, h, `0' - 1 3/4"`, desc, mat, null, hw, closer, fire, null, to];

/** Schedule A (building) + Schedule B (units/cottages type schedule) on one sheet. */
export function doorScheduleRows() {
  const rows: (string | number | null)[][] = [];
  const merges: string[] = [];
  const header = () => {
    const r = rows.length + 1;
    rows.push([...HEAD1], [...HEAD2]);
    merges.push(`A${r}:A${r + 1}`, `B${r}:B${r + 1}`, `C${r}:C${r + 1}`, `D${r}:F${r}`);
  };
  rows.push(["Building Door Schedule", ...Array(13).fill(null)]); merges.push("A1:N1");
  header();
  rows.push(door("LOBBY-101", 101, "A1", `3' - 0"`, `7' - 0"`, "SINGLE", "HOLLOW METAL INSULATED CORE", "Group 2", "Closer", "0 MIN", "CORRIDOR"));
  rows.push(door("OFFICE-108a", "108a", "B", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group 3", "", "20 MIN", "LOBBY"));
  rows.push(door("STAIR-E1", "E1", "D", `3' - 6"`, `7' - 0"`, "SINGLE", "HOLLOW METAL INSULATED CORE", "Group 1", "Closer", "90 Min", "EXTERIOR"));
  rows.push(door("CORRIDOR-02", "S301", "P2", `6' - 0"`, `8' - 0"`, "DOUBLE - SMOKEWALL", "HOLLOW METAL INSULATED CORE", "Group 16", "Hold-Open Device", "45 MIN", "CORRIDOR"));
  rows.push(door("STORAGE-150", 150, "H", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group X", "", "0 MIN", "CORRIDOR"));
  rows.push(door("STORAGE-150", 150, "H", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group 3", "", "0 MIN", "CORRIDOR"));
  rows.push(door("STORAGE-151", 151, "H", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group 3", "", "0 MIN", "CORRIDOR"));
  rows.push(door("STORAGE-151", 151, "H", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group 3", "", "0 MIN", "CORRIDOR"));
  rows.push(door("STORAGE-152", 152, "H", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group 3", "", "0 MIN", "CORRIDOR"));
  rows.push(door("STORAGE-152", 152, "H", `3' - 0"`, `7' - 0"`, "SINGLE", "SOLID CORE WOOD", "Group 3", "", "0 MIN", "CORRIDOR"));
  rows.push(Array(14).fill(null));
  // Page break: title and two-row header repeat mid-sheet.
  rows.push(["Building Door Schedule", ...Array(13).fill(null)]); merges.push(`A${rows.length}:N${rows.length}`);
  header();
  rows.push(door("MECH-155", 155, "N2", `3' - 0"`, `7' - 0"`, "SINGLE", "HOLLOW METAL INSULATED CORE", "<varies>", "Closer", "60 MIN", "CORRIDOR"));
  rows.push(door("TRASH-160", 160, "W", `3' - 0"`, `7' - 0"`, "SINGLE", "HOLLOW METAL INSULATED CORE", "Group 23", "Closer", "1 HR", "EXTERIOR"));
  rows.push(Array(14).fill(null));
  rows.push(["Door Schedule - Units/Cottages", ...Array(13).fill(null)]); merges.push(`A${rows.length}:N${rows.length}`);
  rows.push(["DOOR TAG", "ELEVATION TAG", "WIDTH", "HEIGHT", "THICKNESS", "DOOR TYPE", "Description", "FUNCTION", "PANEL TYPE", "FRAME MATERIAL", "HARDWARE", "CLOSER", "FIRE RATING", "COMMENTS"]);
  rows.push([1, "A", `3' - 0"`, `6' - 8"`, `0' - 1 3/4"`, "Single", "ENTRY", "Interior", "SOLID CORE", null, "Group 1", "Closer", "20 MIN", null]);
  rows.push([3, "C", `2' - 8"`, `6' - 8"`, `0' - 1 3/8"`, "Single", "BEDROOM", "Interior", "HOLLOW CORE", null, "Group 30", "", "0 MIN", null]);
  return { rows, merges };
}
export const doorScheduleXlsx = () => { const d = doorScheduleRows(); return buildXlsx(d.rows, d.merges); };

export function doorScheduleCsv(): string {
  const q = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return doorScheduleRows().rows.map((r) => r.map(q).join(",")).join("\r\n");
}

type DocRow = { heading?: string; cells?: string[] };
export function buildDocx(rows: DocRow[]): Uint8Array {
  const run = (t: string) => t.split("\n").map((line) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join("");
  const tr = (r: DocRow) => r.heading !== undefined
    ? `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="4"/></w:tcPr>${run(r.heading)}</w:tc></w:tr>`
    : `<w:tr>${r.cells!.map((c) => `<w:tc><w:tcPr/>${run(c)}</w:tc>`).join("")}</w:tr>`;
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOOR HARDWARE SCHEDULE</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>${rows.map(tr).join("")}</w:tbl></w:body></w:document>`;
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(doc) });
}

export function hardwareRows(): DocRow[] {
  const item = (q: number, d: string, c: string, m: string): DocRow => ({ cells: [String(q), d, c, m] });
  const rows: DocRow[] = [{ cells: ["Qty", "Description", "Catalog Number", "Mfr"] }];
  for (const v of ["1-EXT", "1-GAR", "1-INT"]) rows.push({ heading: `Group: ${v}` }, item(3, "Standard Weight Hinge", `BB31 4 1/2" x 4 1/2" US10B`, "Cal-Royal"), item(1, "Storeroom Lockset", "SL08 US26D", "Cal-Royal"));
  rows.push({ heading: "Group: 2" }, item(1, "Rim Exit Device", "AF7700EO US10B", "Cal-Royal"), item(1, "Surface Mount Closer", "MDHR-1 DURO", "Cal-Royal"),
    item(1, "Wall Stop", "1270WV .630", "Trimco"), item(1, "Electric Strike", "4300-313", "Adams Rite"), item(1, "Gasketing", "BY DOOR SUPPLIER", ""));
  rows.push({ heading: "Group: 3" }, item(3, "Hinge", "BB31 US26D NRP", "Cal-Royal"), item(1, "Passage Set", "PS10 US11P", "Johnson"),
    item(1, "Masterkeyed Cylinder", "AS REQUIRED BY HARDWARE", "Cal-Royal"), item(1, "Threshold", "PER SILL DETAIL", ""), item(1, "Flux Capacitor", "FC-88 US10BE", "Acme Doorworks"));
  rows.push({ heading: "Group: 11" }, { heading: "\u2022 All hardware furnished by the door supplier" });
  rows.push({ heading: "Group: 16" }, item(2, "Magnetic Hold Open", "SDC-1561 .630", "SDC"), item(2, "Cylinder Operated Flush Bolt", "FB358 US26D", "Trimco"));
  rows.push({ heading: "Group: 22" }, item(1, "Push Plate", "1001-3 .630", "Trimco"));
  rows.push({ heading: "Group: 24" }, item(1, "Kick Plate", "K0050 .630", "Trimco"));
  rows.push({ heading: "Miscellaneous Items" }, item(10, "Spare Cylinder Cores", "CORE US26D", "Cal-Royal"));
  return rows;
}
export const hardwareDocx = () => buildDocx(hardwareRows());
