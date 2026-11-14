import { createHash } from "node:crypto";
import { pool } from "../db/pool";
import { buildPrivateVisitReportKey, getObjectBytes, putPrivateBytes } from "./storage";
import { generateNfpaVisitPdf } from "./nfpa80Report";
import type { VisitReportData } from "./inspectionVisits";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function officialVisitPdf(input: {
  visitId: string;
  organizationId: string;
  propertyId: string;
  userId: string;
  report: VisitReportData;
}): Promise<{ pdf: Buffer; storageKey: string; reused: boolean }> {
  const existing = await pool.query(
    `SELECT report_storage_key, report_sha256 FROM inspection_visits WHERE id=$1 AND organization_id=$2`,
    [input.visitId, input.organizationId],
  );
  const storedKey = existing.rows[0]?.report_storage_key as string | null;
  if (storedKey) {
    const pdf = Buffer.from(await getObjectBytes(storedKey, MAX_PDF_BYTES));
    const sha = createHash("sha256").update(pdf).digest("hex");
    if (existing.rows[0].report_sha256 && sha !== existing.rows[0].report_sha256) throw new Error("official_pdf_mismatch");
    return { pdf, storageKey: storedKey, reused: true };
  }
  const pdf = await generateNfpaVisitPdf(input.report);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const storageKey = buildPrivateVisitReportKey(input.organizationId, input.propertyId, input.visitId);
  await putPrivateBytes(storageKey, pdf, "application/pdf");
  const saved = await pool.query(
    `UPDATE inspection_visits
     SET report_storage_key=$3, report_sha256=$4, report_generated_at=now(), report_generated_by=$5
     WHERE id=$1 AND organization_id=$2 AND report_storage_key IS NULL
     RETURNING report_storage_key`,
    [input.visitId, input.organizationId, storageKey, sha256, input.userId],
  );
  if (!saved.rowCount) {
    const winner = await pool.query(`SELECT report_storage_key FROM inspection_visits WHERE id=$1 AND organization_id=$2`, [input.visitId, input.organizationId]);
    const key = winner.rows[0].report_storage_key as string;
    return { pdf: Buffer.from(await getObjectBytes(key, MAX_PDF_BYTES)), storageKey: key, reused: true };
  }
  return { pdf, storageKey, reused: false };
}
