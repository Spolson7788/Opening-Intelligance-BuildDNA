import PDFDocument from "pdfkit";
import { NFPA80_ITEMS } from "./nfpa80Checklist";

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
    doc.fontSize(18).text("Fire Door Inspection Report");
    doc.moveDown(0.3);
    doc.fillColor("#000").fontSize(12).font("Helvetica-Bold").text(data.openingCode);
    if (data.location) doc.fillColor(GRAY).fontSize(10).font("Helvetica").text(data.location);
    doc.fillColor(GRAY).fontSize(9).text(`Inspection date ${data.eventDate}`);
    doc.text(`Inspector ${data.inspectorName || "Not named"}`);
    doc.text(`Qualification ${data.qualification || "Not recorded"}`);
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
