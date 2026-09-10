import PDFDocument from "pdfkit";

const PAGE_MARGIN = 50;
const NAVY = "#1E2A3A";
const DANGER = "#C93838";
const SUCCESS = "#2F8F47";
const WARNING = "#B8790F";
const GRAY = "#6B7178";

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Writes footer page numbers without triggering PDFKit's silent extra-blank-page
// bug — same root cause and same fix as the compliance report (see README §20):
// text placed inside the bottom margin makes PDFKit think it needs to overflow
// onto a new page unless the margin is temporarily zeroed for that write.
function writeFooterPageNumbers(doc: PDFKit.PDFDocument) {
  const pageCount = doc.bufferedPageRange().count;
  const bottomMargin = doc.page.margins.bottom;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.fillColor(GRAY).fontSize(8).font("Helvetica")
      .text(`Page ${i + 1} of ${pageCount}`, PAGE_MARGIN, doc.page.height - 30, {
        width: doc.page.width - 2 * PAGE_MARGIN,
        align: "center",
      });
    doc.page.margins.bottom = bottomMargin;
  }
}

function writeHeader(doc: PDFKit.PDFDocument, title: string, subtitle: string, generatedAt: Date) {
  doc.fillColor(NAVY).fontSize(9).font("Helvetica-Bold").text("OPENING INTELLIGENCE PLATFORM", { characterSpacing: 1 });
  doc.moveDown(0.3);
  doc.fillColor(NAVY).fontSize(20).font("Helvetica-Bold").text(title);
  doc.moveDown(0.2);
  doc.fillColor("#000000").fontSize(13).font("Helvetica-Bold").text(subtitle);
  doc.fillColor(GRAY).fontSize(9).font("Helvetica")
    .text(`Generated ${generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`);
  doc.moveDown(1);
}

function writeStatRow(doc: PDFKit.PDFDocument, items: Array<[string, string, string]>) {
  const y = doc.y;
  const colWidth = (doc.page.width - 2 * PAGE_MARGIN) / items.length;
  items.forEach(([label, value, color], i) => {
    const x = PAGE_MARGIN + i * colWidth;
    doc.fillColor(GRAY).fontSize(8).font("Helvetica").text(label.toUpperCase(), x, y, { width: colWidth - 10, characterSpacing: 0.5 });
    doc.fillColor(color).fontSize(20).font("Helvetica-Bold").text(value, x, y + 12, { width: colWidth - 10 });
  });
  doc.y = y + 46;
  doc.moveDown(1);
}

export interface ForecastBucketData {
  label: string;
  total: number;
  known_cost_total: number;
  needing_estimate_by_type: Record<string, number>;
}

const BUCKET_ORDER = ["urgent", "near_term", "healthy", "unassessed"] as const;

function bucketDollarTotal(bucket: ForecastBucketData, costs: Record<string, number>): number {
  const estimated = Object.entries(bucket.needing_estimate_by_type).reduce(
    (sum, [type, count]) => sum + count * (costs[type] ?? 0),
    0
  );
  return bucket.known_cost_total + estimated;
}

export interface SinglePropertyForecastData {
  mode: "single_property";
  propertyName: string;
  generatedAt: Date;
  totalOpenings: number;
  buckets: Record<string, ForecastBucketData>;
  costs: Record<string, number>;
}

export interface PortfolioRollupForecastData {
  mode: "portfolio_rollup";
  generatedAt: Date;
  properties: Array<{ propertyName: string; totalOpenings: number; buckets: Record<string, ForecastBucketData> }>;
  costs: Record<string, number>;
}

export type CapitalForecastReportData = SinglePropertyForecastData | PortfolioRollupForecastData;

export function generateCapitalForecastPdf(data: CapitalForecastReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (data.mode === "single_property") {
      const grandTotal = BUCKET_ORDER.reduce((sum, key) => sum + bucketDollarTotal(data.buckets[key], data.costs), 0);
      const urgentPlusNearTerm = bucketDollarTotal(data.buckets.urgent, data.costs) + bucketDollarTotal(data.buckets.near_term, data.costs);
      const assessedCount = data.totalOpenings - data.buckets.unassessed.total;

      writeHeader(doc, "Capital Forecast", data.propertyName, data.generatedAt);
      writeStatRow(doc, [
        ["Urgent + Near-Term", currency(urgentPlusNearTerm), DANGER],
        ["Total Value at Risk", currency(grandTotal), NAVY],
        ["Openings Assessed", `${assessedCount} / ${data.totalOpenings}`, NAVY],
      ]);

      doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Breakdown by Timeline");
      doc.moveDown(0.4);
      for (const key of BUCKET_ORDER) {
        const bucket = data.buckets[key];
        if (bucket.total === 0) continue;
        const rowY = doc.y;
        doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold").text(bucket.label, PAGE_MARGIN, rowY, { width: 320 });
        doc.fillColor(NAVY).fontSize(10).font("Helvetica-Bold")
          .text(currency(bucketDollarTotal(bucket, data.costs)), doc.page.width - PAGE_MARGIN - 120, rowY, { width: 120, align: "right" });
        doc.fillColor(GRAY).fontSize(9).font("Helvetica").text(`${bucket.total} opening${bucket.total === 1 ? "" : "s"}`, PAGE_MARGIN, doc.y + 1);
        doc.moveDown(0.6);
        doc.strokeColor("#E2E0D8").lineWidth(0.5).moveTo(PAGE_MARGIN, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).stroke();
        doc.moveDown(0.4);
      }
    } else {
      const ranked = data.properties
        .map((p) => ({ ...p, total: BUCKET_ORDER.reduce((sum, key) => sum + bucketDollarTotal(p.buckets[key], data.costs), 0) }))
        .sort((a, b) => b.total - a.total);
      const grandTotal = ranked.reduce((sum, p) => sum + p.total, 0);
      const urgentPlusNearTerm = ranked.reduce(
        (sum, p) => sum + bucketDollarTotal(p.buckets.urgent, data.costs) + bucketDollarTotal(p.buckets.near_term, data.costs),
        0
      );

      writeHeader(doc, "Capital Forecast", "Portfolio Rollup — All Properties", data.generatedAt);
      writeStatRow(doc, [
        ["Urgent + Near-Term", currency(urgentPlusNearTerm), DANGER],
        ["Total Portfolio Value at Risk", currency(grandTotal), NAVY],
        ["Properties", String(ranked.length), NAVY],
      ]);

      doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Properties Ranked by Risk");
      doc.moveDown(0.4);
      for (const p of ranked) {
        if (doc.y > doc.page.height - 100) doc.addPage();
        const rowY = doc.y;
        doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold").text(p.propertyName, PAGE_MARGIN, rowY, { width: 320 });
        doc.fillColor(NAVY).fontSize(10).font("Helvetica-Bold")
          .text(currency(p.total), doc.page.width - PAGE_MARGIN - 120, rowY, { width: 120, align: "right" });
        doc.fillColor(GRAY).fontSize(9).font("Helvetica").text(`${p.totalOpenings} opening${p.totalOpenings === 1 ? "" : "s"}`, PAGE_MARGIN, doc.y + 1);
        doc.moveDown(0.6);
        doc.strokeColor("#E2E0D8").lineWidth(0.5).moveTo(PAGE_MARGIN, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).stroke();
        doc.moveDown(0.4);
      }
    }

    writeFooterPageNumbers(doc);
    doc.end();
  });
}
