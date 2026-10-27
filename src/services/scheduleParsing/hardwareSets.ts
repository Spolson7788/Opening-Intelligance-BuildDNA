import { DocxTable } from "./ooxml";
import { canonicalManufacturer, classifyItem, ComponentType, furnishedByText, splitFinish } from "./catalog";
import { normalizeSetKey } from "./normalize";
import type { Issue } from "./doorSchedule";

export type ParsedSetItem = {
  position: number; qty: number | null; description: string;
  catalog_raw: string | null; catalog: string | null; finish: string | null; finish_bhma: string | null; options: string | null;
  manufacturer_raw: string | null; manufacturer: string | null; furnished_by: string | null;
  item_type: string; component_type: ComponentType; needs_review: boolean; review_reasons: string[];
};
export type ParsedSet = { set_key: string; heading_raw: string; notes: string | null; furnished_by_others: boolean; source_table: number; items: ParsedSetItem[] };
export type HardwareParse = { sets: ParsedSet[]; misc_items_excluded: number; issues: Issue[] };

const HEADING = /^(?:hardware\s+)?(?:group|set|hw\s*set|heading)\s*(?:no\.?|#)?\s*[:#-]?\s*(.+)$/i;
const MISC = /^misc(ellaneous)?\b/i;
const FURNISHED_NOTE = /furnished by (the )?(door|frame|others|supplier|door supplier)|by others|n\.?i\.?c/i;

export function parseHardwareTables(tables: DocxTable[]): HardwareParse {
  const out: HardwareParse = { sets: [], misc_items_excluded: 0, issues: [] };
  let current: ParsedSet | null = null; let inMisc = false;
  const notes = new Map<ParsedSet, string[]>();
  tables.forEach((table, ti) => {
    for (const row of table) {
      const cells = row.filter((c) => c.text !== "" || c.span > 1);
      const texts = row.map((c) => c.text.trim());
      const nonEmpty = texts.filter(Boolean);
      if (!nonEmpty.length) continue;
      const merged = row.length === 1 || row.some((c) => c.span >= 3) || new Set(nonEmpty).size === 1 && nonEmpty.length < 2;
      if (merged && nonEmpty.length === 1) {
        const t = nonEmpty[0].replace(/\s+/g, " ").trim();
        if (MISC.test(t)) { inMisc = true; current = null; continue; }
        const h = HEADING.exec(t);
        if (h) {
          inMisc = false;
          const variants = h[1].split(/\s*\/\s*/).map((v) => v.trim()).filter(Boolean);
          // "Group: 1-EXT/1-GAR/1-INT" is one heading naming several variants that share the items below.
          const keys = variants.map((v) => normalizeSetKey(v)).filter((k): k is string => !!k);
          if (!keys.length) { out.issues.push({ code: "bad_heading", message: `Unreadable set heading "${t}"` }); current = null; continue; }
          const created = keys.map((k) => {
            if (out.sets.some((s) => s.set_key === k)) out.issues.push({ code: "duplicate_set", message: `Hardware set ${k} appears more than once; later items appended` });
            const existing = out.sets.find((s) => s.set_key === k);
            if (existing) return existing;
            const s: ParsedSet = { set_key: k, heading_raw: t, notes: null, furnished_by_others: false, source_table: ti, items: [] };
            out.sets.push(s); notes.set(s, []); return s;
          });
          current = created[0];
          (current as any)._aliases = created.slice(1);
          continue;
        }
        if (current) notes.get(current)!.push(t);
        continue;
      }
      const qtyText = texts[0];
      if (/^\d+$/.test(qtyText) && texts.length >= 2) {
        if (inMisc) { out.misc_items_excluded++; continue; }
        if (!current) { out.issues.push({ code: "orphan_item", message: `Item "${texts[1]}" has no set heading` }); continue; }
        const description = texts[1].replace(/\s+/g, " ");
        const catalogRaw = texts[2] ? texts[2].replace(/\s+/g, " ") : null;
        const manufacturerRaw = texts[3] ? texts[3].replace(/\s+/g, " ") : null;
        const furnished = furnishedByText(catalogRaw);
        const split = furnished ? { catalog: null, finish: null, finish_bhma: null, options: null } : splitFinish(catalogRaw);
        const cls = classifyItem(description);
        const manufacturer = canonicalManufacturer(manufacturerRaw);
        const reasons: string[] = [];
        if (!cls.matched) reasons.push("unknown_component_type");
        if (manufacturerRaw && !manufacturer) reasons.push("unknown_manufacturer");
        if (!manufacturerRaw && !furnished) reasons.push("missing_manufacturer");
        const targets = [current, ...((current as any)._aliases ?? [])] as ParsedSet[];
        for (const s of targets) s.items.push({
          position: s.items.length + 1, qty: parseInt(qtyText, 10), description, catalog_raw: catalogRaw, ...split,
          manufacturer_raw: manufacturerRaw, manufacturer, furnished_by: furnished,
          item_type: cls.item_type, component_type: cls.component_type, needs_review: reasons.length > 0, review_reasons: reasons,
        });
        continue;
      }
      if (/^qty$/i.test(qtyText)) continue; // column header row
      if (current && !inMisc) notes.get(current)!.push(nonEmpty.join(" "));
      void cells;
    }
  });
  for (const s of out.sets) {
    delete (s as any)._aliases;
    const n = notes.get(s) ?? [];
    s.notes = n.length ? n.join("\n") : null;
    s.furnished_by_others = s.items.length === 0 && FURNISHED_NOTE.test(s.notes ?? "");
    if (!s.items.length && !s.furnished_by_others) out.issues.push({ code: "empty_set", message: `Hardware set ${s.set_key} has no items` });
  }
  return out;
}
