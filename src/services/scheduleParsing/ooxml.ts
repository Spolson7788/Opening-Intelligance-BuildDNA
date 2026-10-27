import { unzipSync, strFromU8 } from "fflate";

// Minimal, dependency-light OOXML readers. fflate only unzips; the XML we need
// (sheet cells, shared strings, merges, Word table rows) is flat and regular, so
// a small tag scanner is enough and avoids pulling a full spreadsheet engine
// into the Netlify function bundle.
export const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024;

export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw new Error("archive_too_large");
      return /\.(xml|rels)$/i.test(f.name);
    },
  });
  return files;
}

export function text(files: Record<string, Uint8Array>, name: string): string | null {
  const f = files[name];
  return f ? strFromU8(f) : null;
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">";
    if (k === "quot") return '"'; if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

/** Top-level <tag ...>...</tag> or <tag/> elements (non-nested for same tag). */
export function elements(xml: string, tag: string): { open: string; inner: string }[] {
  const out: { open: string; inner: string }[] = [];
  const re = new RegExp(`<${tag}(?=[\\s>/])([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ open: `<${tag}${m[1]}>`, inner: m[3] ?? "" });
  return out;
}

export function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function rowIndex(ref: string): number {
  return parseInt(/\d+/.exec(ref)?.[0] ?? "1", 10) - 1;
}

export type Grid = { name: string; rows: string[][] };

/** All worksheets as string grids. Merged ranges are filled from their top-left cell. */
export function readXlsx(bytes: Uint8Array): Grid[] {
  const files = unzip(bytes);
  const shared: string[] = [];
  const sst = text(files, "xl/sharedStrings.xml");
  if (sst) for (const si of elements(sst, "si")) {
    shared.push(elements(si.inner, "t").map((t) => decodeXml(t.inner)).join(""));
  }
  const wb = text(files, "xl/workbook.xml") ?? "";
  const rels = text(files, "xl/_rels/workbook.xml.rels") ?? "";
  const relTarget = new Map(elements(rels, "Relationship").map((r) => [attr(r.open, "Id"), attr(r.open, "Target")]));
  const sheets = elements(wb, "sheet").map((s, i) => {
    const target = relTarget.get(attr(s.open, "r:id")) ?? `worksheets/sheet${i + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    return { name: attr(s.open, "name") ?? `Sheet${i + 1}`, path };
  });
  const out: Grid[] = [];
  for (const s of sheets) {
    const xml = text(files, s.path);
    if (!xml) continue;
    const rows: string[][] = [];
    for (const r of elements(xml, "row")) {
      for (const c of elements(r.inner, "c")) {
        const ref = attr(c.open, "r");
        if (!ref) continue;
        const t = attr(c.open, "t");
        let v = "";
        if (t === "inlineStr") v = elements(c.inner, "t").map((x) => decodeXml(x.inner)).join("");
        else {
          const raw = elements(c.inner, "v")[0]?.inner;
          if (raw === undefined) continue;
          v = t === "s" ? shared[parseInt(raw, 10)] ?? "" : decodeXml(raw);
        }
        const ri = rowIndex(ref), ci = colIndex(ref);
        (rows[ri] ??= [])[ci] = v;
      }
    }
    for (const m of elements(xml, "mergeCell")) {
      const [a, b] = (attr(m.open, "ref") ?? "").split(":");
      if (!a || !b) continue;
      const r0 = rowIndex(a), c0 = colIndex(a), r1 = rowIndex(b), c1 = colIndex(b);
      const v = rows[r0]?.[c0] ?? "";
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) (rows[r] ??= [])[c] = v;
    }
    let width = 0;
    for (let i = 0; i < rows.length; i++) width = Math.max(width, rows[i]?.length ?? 0); // rows is sparse
    out.push({ name: s.name, rows: Array.from({ length: rows.length }, (_, i) => Array.from({ length: width }, (_, j) => rows[i]?.[j] ?? "")) });
  }
  return out;
}

export type DocxCell = { text: string; span: number };
export type DocxTable = DocxCell[][];

/** Word tables as rows of cells; paragraph breaks inside a cell become "\n". */
export function readDocxTables(bytes: Uint8Array): DocxTable[] {
  const files = unzip(bytes);
  const xml = text(files, "word/document.xml");
  if (!xml) throw new Error("not_a_docx");
  return elements(xml, "w:tbl").map((tbl) => elements(tbl.inner, "w:tr").map((tr) => elements(tr.inner, "w:tc").map((tc) => {
    const span = parseInt(attr(elements(tc.inner, "w:gridSpan")[0]?.open ?? "", "w:val") ?? "1", 10) || 1;
    const paras = elements(tc.inner, "w:p").map((p) => {
      const parts: string[] = [];
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(p.inner))) parts.push(m[1] !== undefined ? decodeXml(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n");
      return parts.join("");
    });
    return { text: paras.join("\n").trim(), span };
  })));
}
