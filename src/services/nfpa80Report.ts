import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import { NFPA80_EDITION, NFPA80_ITEMS } from "./nfpa80Checklist";
import { orderVisitDoors, visitCounts, type VisitDoor, type VisitReportData } from "./inspectionVisits";

export const CONCEPT = {
  ink: "#142C3C",
  cyan: "#8AD8F0",
  blue: "#C5EBF7",
  green: "#A8D978",
  red: "#8E1B22",
  white: "#FFFFFF",
};

export function pdfRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255].join(" ");
}

export function drawablePhoto(bytes: Buffer | null): { width: number; height: number } | null {
  if (!bytes || bytes.length < 32) return null;
  let width = 0;
  let height = 0;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const size = bytes.readUInt16BE(offset + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      if (size < 2) break;
      offset += 2 + size;
    }
  }
  if (width < 32 || height < 32 || width > 8000 || height > 8000) return null;
  return { width, height };
}

function logoBytes(): Buffer | null {
  const path = resolve(process.cwd(), "field-app/src/assets/oi-logo.png");
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

function fill(doc: PDFKit.PDFDocument, hex: string) {
  doc.fillColor(hex);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function band(doc: PDFKit.PDFDocument, title: string, color: string) {
  ensureSpace(doc, 56);
  const y = doc.y;
  doc.save();
  doc.rect(48, y, doc.page.width - 96, 22).fill(color);
  doc.restore();
  fill(doc, CONCEPT.ink);
  doc.font("Helvetica-Bold").fontSize(12).text(title, 56, y + 5, { width: doc.page.width - 112 });
  doc.y = y + 30;
}

function stampPages(doc: PDFKit.PDFDocument, footer: string) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica").fontSize(8);
    doc.text(footer, 48, doc.page.height - 32, { lineBreak: false });
    doc.text(`Page ${index + 1} of ${range.count}`, 430, doc.page.height - 32, { lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

export interface NfpaReportDeficiency {
  item_key: string;
  note: string;
  status: string;
  repair_note: string | null;
  repaired_at: string | null;
}

export interface NfpaReportData {
  openingCode: string;
  location: string | null;
  eventDate: string;
  inspectorName: string | null;
  qualification: string | null;
  licenseNumber: string | null;
  passed: boolean;
  notes: string | null;
  signatureData: string | null;
  checklist: { items?: Record<string, { result?: string; note?: string | null }> } | null;
  deficiencies: NfpaReportDeficiency[];
}

function drawPhoto(doc: PDFKit.PDFDocument, photo: Buffer | null) {
  const size = drawablePhoto(photo);
  if (!photo || !size) {
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica").fontSize(9).text("Photograph stored with this inspection");
    return;
  }
  const width = Math.min(220, size.width);
  try { doc.image(photo, { width }); }
  catch { fill(doc, CONCEPT.ink); doc.font("Helvetica").fontSize(9).text("Photograph stored with this inspection"); }
}

export function generateNfpaInspectionPdf(data: NfpaReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const logo = logoBytes();
    if (logo) doc.image(logo, 48, 36, { height: 36 });
    doc.y = logo ? 80 : 48;
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica-Bold").fontSize(16).text(`Fire Door Inspection Report (NFPA 80 ${NFPA80_EDITION})`);
    doc.fontSize(12).text(data.openingCode);
    if (data.location) doc.font("Helvetica").fontSize(10).text(data.location);
    doc.fontSize(9).text(`Inspection date ${data.eventDate}`);
    doc.text(`Inspector ${data.inspectorName || "Not named"}`);
    doc.text(`Qualification ${data.qualification || "Not recorded"}`);
    doc.text(`License ${data.licenseNumber || "Not recorded"}`);
    fill(doc, data.passed ? CONCEPT.green : CONCEPT.red);
    doc.font("Helvetica-Bold").fontSize(11).text(data.passed ? "Result: passed" : "Result: failed");
    if (data.notes) { fill(doc, CONCEPT.ink); doc.font("Helvetica").fontSize(9).text(data.notes); }
    band(doc, "Checklist", CONCEPT.cyan);
    const answers = data.checklist?.items ?? {};
    for (const item of NFPA80_ITEMS) {
      const answer = answers[item.key];
      const result = (answer?.result || "unanswered").toUpperCase();
      fill(doc, result === "FAIL" ? CONCEPT.red : CONCEPT.ink);
      doc.font("Helvetica-Bold").fontSize(9).text(`${item.section}  ${result}`);
      fill(doc, CONCEPT.ink);
      doc.font("Helvetica").fontSize(8).text(item.text);
      if (answer?.note) doc.text(`Note: ${answer.note}`);
    }
    band(doc, "Deficiencies and repairs", CONCEPT.blue);
    if (data.deficiencies.length === 0) {
      fill(doc, CONCEPT.ink);
      doc.font("Helvetica").fontSize(10).text("No deficiencies were recorded on this inspection.");
    } else {
      for (const row of data.deficiencies) {
        const spec = NFPA80_ITEMS.find((item) => item.key === row.item_key);
        fill(doc, CONCEPT.red);
        doc.font("Helvetica-Bold").fontSize(10).text(`${spec?.section || row.item_key}  ${row.status}`);
        fill(doc, CONCEPT.ink);
        doc.font("Helvetica").fontSize(9).text(spec?.text || row.note);
        doc.text(row.note);
        if (row.repair_note) doc.text(`Repair: ${row.repair_note}${row.repaired_at ? ` (${String(row.repaired_at).slice(0, 10)})` : ""}`);
      }
    }
    band(doc, "Signature", CONCEPT.green);
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica").fontSize(10).text(`${data.inspectorName || "Not named"} · ${data.qualification || "Qualification not recorded"} · License ${data.licenseNumber || "Not recorded"}`);
    if (data.signatureData?.startsWith("data:image/")) {
      try { doc.image(Buffer.from(data.signatureData.split(",")[1] || "", "base64"), { height: 48 }); } catch { /* keep the text block */ }
    }
    stampPages(doc, `${data.openingCode} · ${data.eventDate} · ${data.inspectorName || "Inspector"}`);
    doc.end();
  });
}

function doorTable(doc: PDFKit.PDFDocument, door: VisitDoor) {
  fill(doc, CONCEPT.ink);
  doc.font("Helvetica-Bold").fontSize(11).text(door.openingCode);
  doc.font("Helvetica").fontSize(9).text(door.location || "Location not recorded");
  fill(doc, door.passed ? CONCEPT.ink : CONCEPT.red);
  doc.font("Helvetica-Bold").text(door.passed ? "Result: passed" : "Result: failed");
  for (const item of door.checklist) {
    fill(doc, item.result === "FAIL" ? CONCEPT.red : CONCEPT.ink);
    doc.font("Helvetica").fontSize(8).text(`${item.section}  ${item.result}${item.note ? `  ${item.note}` : ""}`);
  }
}

export function generateNfpaVisitPdf(data: VisitReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const doors = orderVisitDoors(data.doors);
    const counts = visitCounts(doors);
    const logo = logoBytes();
    if (logo) doc.image(logo, 48, 36, { height: 36 });
    doc.y = logo ? 80 : 48;
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica-Bold").fontSize(16).text("Fire Door Inspection Visit");
    doc.fontSize(13).text(data.facilityName);
    doc.font("Helvetica").fontSize(10).text(`Inspection date ${data.eventDate}`);
    doc.text(`Inspector ${data.inspectorName || "Not named"}`);
    band(doc, "Summary", CONCEPT.green);
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica-Bold").fontSize(11).text(`Inspected ${counts.inspected}    Passed ${counts.passed}    Failed ${counts.failed}`);
    band(doc, "Failed doors", CONCEPT.cyan);
    const failed = doors.filter((door) => !door.passed);
    if (!failed.length) {
      fill(doc, CONCEPT.ink);
      doc.font("Helvetica").fontSize(10).text("No doors failed on this visit.");
    }
    for (const door of failed) {
      fill(doc, CONCEPT.ink);
      doc.font("Helvetica-Bold").fontSize(12).text(door.openingCode);
      if (door.location) doc.font("Helvetica").fontSize(9).text(door.location);
      for (const deficiency of door.deficiencies) {
        fill(doc, CONCEPT.red);
        doc.font("Helvetica-Bold").fontSize(10).text(deficiency.section);
        fill(doc, CONCEPT.ink);
        doc.font("Helvetica").fontSize(9).text(deficiency.description || deficiency.section);
        doc.text(deficiency.note);
        drawPhoto(doc, deficiency.photo);
      }
      if (door.notes) { fill(doc, CONCEPT.ink); doc.font("Helvetica").fontSize(9).text(door.notes); }
      doc.moveDown(0.4);
    }
    band(doc, "Door details", CONCEPT.blue);
    for (const door of doors) doorTable(doc, door);
    band(doc, "Signature", CONCEPT.green);
    fill(doc, CONCEPT.ink);
    doc.font("Helvetica").fontSize(10).text(`${data.inspectorName || "Not named"} · ${data.qualification || "Qualification not recorded"} · License ${data.licenseNumber || "Not recorded"}`);
    if (data.signatureData?.startsWith("data:image/")) {
      try { doc.image(Buffer.from(data.signatureData.split(",")[1] || "", "base64"), { height: 48 }); } catch { /* keep the qualification text */ }
    }
    stampPages(doc, `${data.facilityName} · ${data.eventDate} · ${data.inspectorName || "Inspector"}`);
    doc.end();
  });
}
