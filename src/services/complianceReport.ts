import PDFDocument from "pdfkit";

export interface ComplianceReportOpening {
  opening_code: string;
  building_name: string;
  floor_label: string | null;
  location_description: string | null;
  fire_rated: boolean;
  life_safety_critical: boolean;
  health_score: number | null;
  last_inspection_date: string | null;
  last_inspection_passed: boolean | null;
  last_inspection_notes: string | null;
  last_inspection_signed_by: string | null;
  inspection_type: string | null;
  photo_count: number;
}

export interface ComplianceReportData {
  propertyName: string;
  propertyAddress: string | null;
  generatedAt: Date;
  openings: ComplianceReportOpening[];
}

const PAGE_MARGIN = 50;
const NAVY = "#1E2A3A";
const DANGER = "#C93838";
const SUCCESS = "#2F8F47";
const WARNING = "#B8790F";
const GRAY = "#6B7178";

function statusOf(o: ComplianceReportOpening): { label: string; color: string } {
  if (o.last_inspection_date === null) return { label: "NOT YET INSPECTED", color: WARNING };
  if (o.last_inspection_passed === false) return { label: "FAILED", color: DANGER };
  return { label: "PASSED", color: SUCCESS };
}

// Builds the PDF into a Buffer rather than streaming directly to the HTTP
// response — keeps this function testable in isolation (no Express req/res
// needed) and the size here (a few hundred openings at most) is nowhere
// near large enough for buffering in memory to matter.
export function generateComplianceReportPdf(data: ComplianceReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor(NAVY).fontSize(9).font("Helvetica-Bold")
      .text("OPENING INTELLIGENCE PLATFORM", { characterSpacing: 1 });
    doc.moveDown(0.3);
    doc.fillColor(NAVY).fontSize(20).font("Helvetica-Bold")
      .text("Fire Door & Life Safety Compliance Report");
    doc.moveDown(0.2);
    doc.fillColor("#000000").fontSize(13).font("Helvetica-Bold").text(data.propertyName);
    if (data.propertyAddress) {
      doc.fillColor(GRAY).fontSize(10).font("Helvetica").text(data.propertyAddress);
    }
    doc.fillColor(GRAY).fontSize(9).font("Helvetica")
      .text(`Generated ${data.generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`);
    doc.moveDown(1);

    const total = data.openings.length;
    const passed = data.openings.filter((o) => o.last_inspection_passed === true).length;
    const failed = data.openings.filter((o) => o.last_inspection_passed === false).length;
    const notInspected = data.openings.filter((o) => o.last_inspection_date === null).length;

    const summaryY = doc.y;
    const colWidth = (doc.page.width - 2 * PAGE_MARGIN) / 4;
    const summaryItems: [string, string, string][] = [
      ["Total Openings", String(total), NAVY],
      ["Passed", String(passed), SUCCESS],
      ["Failed", String(failed), failed > 0 ? DANGER : GRAY],
      ["Not Yet Inspected", String(notInspected), notInspected > 0 ? WARNING : GRAY],
    ];
    summaryItems.forEach(([label, value, color], i) => {
      const x = PAGE_MARGIN + i * colWidth;
      doc.fillColor(GRAY).fontSize(8).font("Helvetica").text(label.toUpperCase(), x, summaryY, { width: colWidth - 10, characterSpacing: 0.5 });
      doc.fillColor(color).fontSize(22).font("Helvetica-Bold").text(value, x, summaryY + 12, { width: colWidth - 10 });
    });
    doc.y = summaryY + 50;
    doc.moveDown(1);

    if (failed > 0) {
      doc.fillColor(DANGER).fontSize(9).font("Helvetica-Bold")
        .text(`${failed} opening${failed === 1 ? "" : "s"} currently failing inspection require attention before the next compliance review.`);
      doc.moveDown(1);
    }

    const byBuilding = new Map<string, ComplianceReportOpening[]>();
    for (const o of data.openings) {
      const list = byBuilding.get(o.building_name) ?? [];
      list.push(o);
      byBuilding.set(o.building_name, list);
    }

    for (const [buildingName, openings] of byBuilding) {
      if (doc.y > doc.page.height - 150) doc.addPage();
      doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text(buildingName);
      doc.moveDown(0.3);

      for (const o of openings) {
        if (doc.y > doc.page.height - 100) doc.addPage();

        const status = statusOf(o);
        const rowTop = doc.y;

        doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold")
          .text(o.opening_code, PAGE_MARGIN, rowTop, { continued: false });
        doc.fillColor(status.color).fontSize(9).font("Helvetica-Bold")
          .text(status.label, doc.page.width - PAGE_MARGIN - 120, rowTop, { width: 120, align: "right" });

        const badges: string[] = [];
        if (o.fire_rated) badges.push("FIRE RATED");
        if (o.life_safety_critical) badges.push("LIFE SAFETY");
        const locationLine = [o.location_description, o.floor_label ? `Floor ${o.floor_label}` : null]
          .filter(Boolean).join(" · ");

        doc.fillColor(GRAY).fontSize(9).font("Helvetica")
          .text(
            [locationLine, badges.join(" · ")].filter(Boolean).join("  —  "),
            PAGE_MARGIN, doc.y + 2
          );

        if (o.last_inspection_date) {
          doc.fillColor(GRAY).fontSize(8.5).font("Helvetica")
            .text(
              `Last inspected ${new Date(o.last_inspection_date).toLocaleDateString()} (${(o.inspection_type || "general").replace(/_/g, " ")})` +
              (o.photo_count > 0 ? `  ·  ${o.photo_count} photo${o.photo_count === 1 ? "" : "s"} on file` : "") +
              (o.last_inspection_signed_by ? `  ·  Signed off by ${o.last_inspection_signed_by}` : ""),
              PAGE_MARGIN, doc.y + 1
            );
        } else {
          doc.fillColor(WARNING).fontSize(8.5).font("Helvetica-Bold")
            .text("No inspection on record", PAGE_MARGIN, doc.y + 1);
        }

        if (o.last_inspection_passed === false && o.last_inspection_notes) {
          doc.fillColor(DANGER).fontSize(8.5).font("Helvetica-Oblique")
            .text(`Note: ${o.last_inspection_notes}`, PAGE_MARGIN, doc.y + 1, { width: doc.page.width - 2 * PAGE_MARGIN });
        }

        doc.moveDown(0.6);
        doc.strokeColor("#E2E0D8").lineWidth(0.5)
          .moveTo(PAGE_MARGIN, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).stroke();
        doc.moveDown(0.4);
      }
      doc.moveDown(0.5);
    }

    const pageCount = doc.bufferedPageRange().count;
    const bottomMargin = doc.page.margins.bottom;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // otherwise pdfkit thinks this text overflows the page and silently adds a blank one
      doc.fillColor(GRAY).fontSize(8).font("Helvetica")
        .text(`Page ${i + 1} of ${pageCount}`, PAGE_MARGIN, doc.page.height - 30, {
          width: doc.page.width - 2 * PAGE_MARGIN,
          align: "center",
        });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
