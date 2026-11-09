import PDFDocument from "pdfkit";
import { NFPA80_EDITION, NFPA80_ITEMS } from "./nfpa80Checklist";
import { orderVisitDoors, visitCounts, type VisitReportData } from "./inspectionVisits";

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

const NAVY = "#1E2A3A";
const GRAY = "#6B7178";

export function generateNfpaInspectionPdf(data: NfpaReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor(NAVY).fontSize(9).font("Helvetica-Bold").text("OPENING INTELLIGENCE PLATFORM");
    doc.moveDown(0.3);
    doc.fontSize(18).text(`Fire Door Inspection Report (NFPA 80 ${NFPA80_EDITION})`);
    doc.moveDown(0.3);
    doc.fillColor("#000").fontSize(12).font("Helvetica-Bold").text(data.openingCode);
    if (data.location) doc.fillColor(GRAY).fontSize(10).font("Helvetica").text(data.location);
    doc.fillColor(GRAY).fontSize(9).text(`Inspection date ${data.eventDate}`);
    doc.text(`Inspector ${data.inspectorName || "Not named"}`);
    doc.text(`Qualification ${data.qualification || "Not recorded"}`);
    doc.text(`License ${data.licenseNumber || "Not recorded"}`);
    doc.fillColor(data.passed ? "#2F8F47" : "#C93838").font("Helvetica-Bold").text(data.passed ? "Result: passed" : "Result: failed");
    if (data.notes) doc.fillColor("#000").font("Helvetica").text(data.notes);
    doc.moveDown(0.6);

    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(12).text("Checklist");
    doc.moveDown(0.3);
    const answers = data.checklist?.items ?? {};
    for (const item of NFPA80_ITEMS) {
      const answer = answers[item.key];
      const result = (answer?.result || "unanswered").toUpperCase();
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(10).text(`${item.section}  ${result}`);
      doc.font("Helvetica").fontSize(9).text(item.text);
      if (answer?.note) doc.fillColor(GRAY).text(`Note: ${answer.note}`);
      doc.moveDown(0.3);
    }

    doc.moveDown(0.3);
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(12).text("Deficiencies and repairs");
    doc.moveDown(0.3);
    if (data.deficiencies.length === 0) {
      doc.fillColor(GRAY).font("Helvetica").fontSize(10).text("No deficiencies were recorded on this inspection.");
    } else {
      for (const row of data.deficiencies) {
        const spec = NFPA80_ITEMS.find((item) => item.key === row.item_key);
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(10).text(`${spec?.section || row.item_key}  ${row.status}`);
        doc.font("Helvetica").fontSize(9).text(row.note);
        if (row.repair_note) doc.fillColor(GRAY).text(`Repair: ${row.repair_note}${row.repaired_at ? ` (${String(row.repaired_at).slice(0, 10)})` : ""}`);
        doc.moveDown(0.3);
      }
    }

    if (data.signatureData?.startsWith("data:image/")) {
      try {
        const bytes = Buffer.from(data.signatureData.split(",")[1] || "", "base64");
        doc.moveDown(0.4);
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(12).text("Signature");
        doc.image(bytes, { fit: [180, 60] });
      } catch { /* a bad signature image must not drop the rest of the report */ }
    }
    doc.end();
  });
}

export function generateNfpaVisitPdf(data: VisitReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const doors = orderVisitDoors(data.doors);
    const counts = visitCounts(doors);
    doc.fillColor(NAVY).fontSize(9).font("Helvetica-Bold").text("OPENING INTELLIGENCE PLATFORM");
    doc.moveDown(0.3);
    doc.fontSize(18).text("Fire Door Inspection Visit");
    doc.moveDown(0.3);
    doc.fillColor("#000").fontSize(12).font("Helvetica-Bold").text(data.facilityName);
    doc.fillColor(GRAY).font("Helvetica").fontSize(10).text(`Inspection date ${data.eventDate}`);
    doc.text(`Inspector ${data.inspectorName || "Not named"}`);
    doc.text(`Qualification ${data.qualification || "Not recorded"}`);
    doc.text(`License ${data.licenseNumber || "Not recorded"}`);
    doc.fillColor("#000").font("Helvetica-Bold").text(`Inspected ${counts.inspected}`);
    doc.text(`Passed ${counts.passed}`);
    doc.text(`Failed ${counts.failed}`);
    doc.moveDown(0.6);
    doc.fillColor(NAVY).fontSize(14).text("Failed doors");
    doc.moveDown(0.3);
    const failed = doors.filter((door) => !door.passed);
    if (!failed.length) doc.fillColor(GRAY).font("Helvetica").fontSize(10).text("No doors failed on this visit.");
    for (const door of failed) {
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(12).text(door.openingCode);
      if (door.location) doc.fillColor(GRAY).font("Helvetica").fontSize(10).text(door.location);
      for (const deficiency of door.deficiencies) {
        doc.fillColor("#C93838").font("Helvetica-Bold").fontSize(10).text(deficiency.section);
        doc.fillColor("#000").font("Helvetica").fontSize(9).text(deficiency.note);
        if (deficiency.photo && deficiency.photo.length > 24) {
          try { doc.image(deficiency.photo, { fit: [180, 120] }); } catch { doc.fillColor(GRAY).text("Photograph stored with this inspection"); }
        } else doc.fillColor(GRAY).text("Photograph stored with this inspection");
      }
      if (door.notes) doc.fillColor("#000").text(door.notes);
      doc.moveDown(0.4);
    }
    doc.moveDown(0.4);
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(14).text("Door details");
    for (const door of doors) {
      doc.moveDown(0.4);
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(12).text(door.openingCode);
      if (door.location) doc.fillColor(GRAY).font("Helvetica").fontSize(10).text(door.location);
      doc.fillColor(door.passed ? "#2F8F47" : "#C93838").font("Helvetica-Bold").text(door.passed ? "Result: passed" : "Result: failed");
      for (const item of door.checklist) {
        doc.fillColor("#000").font("Helvetica").fontSize(9).text(`${item.section} ${item.result}`);
        if (item.note) doc.fillColor(GRAY).text(`Note: ${item.note}`);
      }
    }
    doc.end();
  });
}
