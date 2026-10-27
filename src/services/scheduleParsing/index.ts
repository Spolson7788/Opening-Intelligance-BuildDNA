import { readDocxTables, readXlsx } from "./ooxml";
import { parseDoorGrids, readCsv } from "./doorSchedule";
import { parseHardwareTables } from "./hardwareSets";
export * from "./doorSchedule";
export * from "./hardwareSets";
export * from "./normalize";
export * from "./catalog";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export class UnsupportedScheduleFormat extends Error {}

export function parseDoorScheduleFile(contentType: string, bytes: Uint8Array) {
  if (contentType === XLSX_TYPE) return parseDoorGrids(readXlsx(bytes));
  if (contentType === "text/csv") return parseDoorGrids([readCsv(new TextDecoder().decode(bytes))]);
  throw new UnsupportedScheduleFormat("door_schedule_format_not_parsed");
}

export function parseHardwareScheduleFile(contentType: string, bytes: Uint8Array) {
  if (contentType === DOCX_TYPE) return parseHardwareTables(readDocxTables(bytes));
  throw new UnsupportedScheduleFormat("hardware_schedule_format_not_parsed");
}
