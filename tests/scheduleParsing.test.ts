import { describe, expect, it } from "vitest";
import { readXlsx } from "../src/services/scheduleParsing/ooxml";
import {
  parseDoorGrids, readCsv, parseHardwareScheduleFile, parseDoorScheduleFile, DOCX_TYPE, XLSX_TYPE,
  parseInches, parseFireMinutes, parseHardwareRef, normalizeMark, splitFinish, classifyItem, canonicalManufacturer, splitRoom,
} from "../src/services/scheduleParsing";
import { doorScheduleXlsx, doorScheduleCsv, hardwareDocx, buildXlsx } from "./fixtures/scheduleFixtures";

describe("schedule value normalization", () => {
  it("keeps marks as text", () => {
    expect(normalizeMark("103")).toBe("103");
    expect(normalizeMark("103.0")).toBe("103");
    expect(normalizeMark(" 108a ")).toBe("108A");
    expect(normalizeMark("E1")).toBe("E1");
    expect(normalizeMark("")).toBeNull();
  });
  it("converts feet-inch sizes to inches", () => {
    expect(parseInches(`3' - 0"`)).toBe(36);
    expect(parseInches(`0' - 1 3/4"`)).toBe(1.75);
    expect(parseInches(`7'-10 1/2"`)).toBe(94.5);
    expect(parseInches(`6' - 8"`)).toBe(80);
    expect(parseInches("36")).toBe(36);
    expect(parseInches(`1 3/8"`)).toBe(1.375);
    expect(parseInches("varies")).toBeNull();
  });
  it("converts fire ratings to minutes", () => {
    expect(parseFireMinutes("0 MIN")).toBe(0);
    expect(parseFireMinutes("90 Min")).toBe(90);
    expect(parseFireMinutes("1 HR")).toBe(60);
    expect(parseFireMinutes("1-1/2 HR")).toBe(90);
    expect(parseFireMinutes("")).toBeNull();
    expect(parseFireMinutes("C-label")).toBe("invalid");
  });
  it("parses Group N to a set key", () => {
    expect(parseHardwareRef("Group 29")).toEqual({ key: "29", varies: false });
    expect(parseHardwareRef("Group X")).toEqual({ key: "X", varies: false });
    expect(parseHardwareRef("<varies>")).toEqual({ key: null, varies: true });
    expect(parseHardwareRef("Group: 1-EXT").key).toBe("1-EXT");
  });
  it("splits room name and number", () => {
    expect(splitRoom("ENTRY VESTIBULE-101")).toEqual({ name: "ENTRY VESTIBULE", number: "101" });
    expect(splitRoom("CORRIDOR")).toEqual({ name: "CORRIDOR", number: null });
  });
  it("splits finish and options off the catalog number", () => {
    expect(splitFinish(`BB31 4 1/2" x 4 1/2" US10B`)).toMatchObject({ catalog: `BB31 4 1/2" x 4 1/2"`, finish: "US10B", finish_bhma: "613" });
    expect(splitFinish("BB31 US26D NRP")).toMatchObject({ catalog: "BB31", finish: "US26D", finish_bhma: "626", options: "NRP" });
    expect(splitFinish("MDHR-1 DURO")).toMatchObject({ catalog: "MDHR-1", finish: "DURO" });
    expect(splitFinish("1270WV .630")).toMatchObject({ catalog: "1270WV", finish: "630", finish_bhma: "630" });
    expect(splitFinish("4300-313")).toMatchObject({ catalog: "4300", finish: "313" });
    expect(splitFinish("1870-30-313")).toMatchObject({ catalog: "1870-30", finish: "313" });
    expect(splitFinish("FC-88 US10BE")).toMatchObject({ finish: "US10BE", finish_bhma: "613E" });
    expect(splitFinish("PS10 US11P")).toMatchObject({ catalog: "PS10", finish: "US11P", finish_bhma: null });
    expect(splitFinish("QDS 410")).toMatchObject({ catalog: "QDS 410", finish: null });
  });
  it("maps descriptions to component types, most specific first", () => {
    expect(classifyItem("Rim Exit Device").component_type).toBe("exit_device");
    expect(classifyItem("Cylinder Operated Flush Bolt")).toMatchObject({ item_type: "flush_bolt", component_type: "other" });
    expect(classifyItem("Magnetic Hold Open")).toMatchObject({ item_type: "hold_open", component_type: "other" });
    expect(classifyItem("Masterkeyed Cylinder").component_type).toBe("cylinder");
    expect(classifyItem("Surface Mount Closer").component_type).toBe("closer");
    expect(classifyItem("Standard Weight Hinge").component_type).toBe("hinge");
    expect(classifyItem("Storeroom Lockset").component_type).toBe("lockset");
    expect(classifyItem("Electric Strike").component_type).toBe("electric_strike");
    expect(classifyItem("Wall Stop").item_type).toBe("stop");
    expect(classifyItem("Entrance Trim").item_type).toBe("exit_trim");
    expect(classifyItem("Wall Switch").item_type).toBe("access_control_other");
    expect(classifyItem("Flux Capacitor")).toMatchObject({ matched: false, component_type: "other" });
  });
  it("normalizes manufacturer aliases", () => {
    expect(canonicalManufacturer("Cal-Royal")).toBe("Cal-Royal");
    expect(canonicalManufacturer("CAL ROYAL")).toBe("Cal-Royal");
    expect(canonicalManufacturer("Johnson")).toBe("Johnson Hardware");
    expect(canonicalManufacturer("Adams Rite")).toBe("Adams Rite");
    expect(canonicalManufacturer("SDC")).toBe("SDC (Security Door Controls)");
    expect(canonicalManufacturer("Acme Doorworks")).toBeNull();
  });
});

describe("door schedule parser (synthetic Revit-style export)", () => {
  const parsed = parseDoorScheduleFile(XLSX_TYPE, doorScheduleXlsx());
  const doors = parsed.rows.filter((r) => r.row_kind === "door");
  const byMark = (m: string) => doors.filter((r) => r.door_mark === m);

  it("reads merged title and two-row header, and finds both schedules", () => {
    expect(parsed.blocks.map((b) => [b.schedule_name, b.kind])).toEqual([["Building Door Schedule", "door"], ["Door Schedule - Units/Cottages", "type_template"]]);
    const cols = parsed.blocks[0].columns;
    expect(Object.values(cols)).toEqual(expect.arrayContaining(["room", "door_mark", "elevation_type", "width", "height", "thickness", "hw_ref", "closer", "fire_rating", "comments", "to_room"]));
  });
  it("skips repeated title/header rows", () => {
    expect(doors.map((r) => r.door_mark)).toEqual(["101", "108A", "E1", "S301", "150", "150", "151", "151", "152", "152", "155", "160"]);
    expect(parsed.issues.some((i) => i.code === "repeated_header")).toBe(true);
  });
  it("detects the shifted material column by content and flags the empty frame column", () => {
    expect(parsed.issues.find((i) => i.code === "column_shift")?.column).toBe("EL_Type Mark_SP");
    expect(parsed.issues.some((i) => i.code === "empty_column")).toBe(true);
    expect(byMark("101")[0].door_material).toBe("HOLLOW METAL INSULATED CORE");
    expect(byMark("101")[0].frame_material).toBeNull();
    expect(byMark("101")[0].elevation_type).toBe("A1");
  });
  it("normalizes sizes, fire ratings, groups and rooms", () => {
    const r = byMark("S301")[0];
    expect([r.width_in, r.height_in, r.thickness_in]).toEqual([72, 96, 1.75]);
    expect(r.fire_rating_minutes).toBe(45);
    expect(r.hw_set_key).toBe("16");
    expect(r.room_name).toBe("CORRIDOR"); expect(r.room_number).toBe("02");
    expect(byMark("E1")[0].fire_rating_minutes).toBe(90);
    expect(byMark("160")[0].fire_rating_minutes).toBe(60);
    expect(byMark("108A")[0].door_mark_raw).toBe("108a");
    expect(byMark("150")[0].hw_set_key).toBe("X");
    expect(byMark("155")[0].hw_set_key).toBeNull();
    expect(byMark("155")[0].issues.map((i) => i.code)).toContain("hw_varies");
  });
  it("keeps units/cottages rows as type templates", () => {
    const t = parsed.rows.filter((r) => r.row_kind === "type_template");
    expect(t.map((r) => [r.door_mark, r.elevation_type, r.configuration, r.door_material, r.width_in, r.thickness_in])).toEqual([["1", "A", "Single", "SOLID CORE", 36, 1.75], ["3", "C", "Single", "HOLLOW CORE", 32, 1.375]]);
  });
  it("parses the same content from CSV", () => {
    const csv = parseDoorScheduleFile("text/csv", new TextEncoder().encode(doorScheduleCsv()));
    expect(csv.rows.filter((r) => r.row_kind === "door").map((r) => r.door_mark)).toEqual(doors.map((r) => r.door_mark));
    expect(readCsv('a,"b ""q"", c"\r\n1,2').rows).toEqual([["a", 'b "q", c'], ["1", "2"]]);
  });
  it("accepts header synonyms", () => {
    const g = readXlsx(buildXlsx([["Door No", "Room", "Hardware Set", "Fire Label", "Width", "Height"], ["7", "Office-12", "HW-4", "20 MIN", "36", "84"]]));
    const p = parseDoorGrids(g);
    expect(p.rows[0]).toMatchObject({ door_mark: "7", hw_set_key: "4", fire_rating_minutes: 20, width_in: 36, height_in: 84 });
  });
  it("reports a file with no header", () => {
    expect(parseDoorGrids([{ name: "x", rows: [["just", "notes"]] }]).issues[0].code).toBe("no_header");
  });
});

describe("hardware schedule parser (synthetic Word export)", () => {
  const hw = parseHardwareScheduleFile(DOCX_TYPE, hardwareDocx());
  const set = (k: string) => hw.sets.find((s) => s.set_key === k)!;
  it("reads merged Group headings and 4-column item rows", () => {
    expect(hw.sets.map((s) => s.set_key)).toEqual(["1-EXT", "1-GAR", "1-INT", "2", "3", "11", "16", "22", "24"]);
    expect(set("2").items.map((i) => i.qty)).toEqual([1, 1, 1, 1, 1]);
    expect(set("1-INT").items[0]).toMatchObject({ qty: 3, description: "Standard Weight Hinge", catalog: `BB31 4 1/2" x 4 1/2"`, finish: "US10B", manufacturer: "Cal-Royal", component_type: "hinge" });
  });
  it("excludes the miscellaneous block", () => {
    expect(hw.misc_items_excluded).toBe(1);
    expect(hw.sets.some((s) => /misc/i.test(s.heading_raw))).toBe(false);
  });
  it("marks notes-only sets as furnished by others", () => {
    expect(set("11")).toMatchObject({ furnished_by_others: true, items: [] });
    expect(set("11").notes).toMatch(/furnished by the door supplier/);
  });
  it("keeps non-catalog values as furnished-by text, not catalog numbers", () => {
    const gasket = set("2").items.find((i) => i.description === "Gasketing")!;
    expect(gasket).toMatchObject({ catalog: null, furnished_by: "BY DOOR SUPPLIER", needs_review: false, item_type: "seal" });
    const cyl = set("3").items.find((i) => i.item_type === "cylinder")!;
    expect(cyl).toMatchObject({ catalog: null, furnished_by: "AS REQUIRED BY HARDWARE" });
    expect(set("3").items.find((i) => i.item_type === "threshold")!.furnished_by).toBe("PER SILL DETAIL");
  });
  it("flags unmatched items for review", () => {
    const flux = set("3").items.find((i) => i.description === "Flux Capacitor")!;
    expect(flux.needs_review).toBe(true);
    expect(flux.review_reasons).toEqual(["unknown_component_type", "unknown_manufacturer"]);
    expect(set("16").items.map((i) => [i.item_type, i.component_type, i.manufacturer])).toEqual([["hold_open", "other", "SDC (Security Door Controls)"], ["flush_bolt", "other", "Trimco"]]);
  });
});
