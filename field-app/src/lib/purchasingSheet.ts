export type SheetKind = "pdf" | "jpeg" | "png";

const MAX_SHEET_BYTES = 7 * 1024 * 1024;

export function sheetKind(bytes: Uint8Array): SheetKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

export function looksLikeSheetPhoto(file: { name: string; type?: string }): boolean {
  return /\.(heic|heif|jpe?g|png)$/i.test(file.name) || (file.type || "").toLowerCase().startsWith("image/");
}

export function purchasingSheetProblem(file: { size: number; name: string; type?: string }, bytes: Uint8Array): string | null {
  if (file.size === 0 || bytes.length === 0) return "This file came through empty. Choose the PDF again from Files or Downloads.";
  if (file.size > MAX_SHEET_BYTES) return "This file is too large to send. Use a PDF or photo under 7 MB.";
  if (!sheetKind(bytes) && !looksLikeSheetPhoto(file)) return "Choose a PDF from Files or Downloads, or a photo of the sheet.";
  return null;
}

export function purchasingSheetName(name: string, kind: SheetKind): string {
  const base = name.replace(/\.[^./\\]+$/, "").trim() || "sheet";
  return `${base}.${kind === "pdf" ? "pdf" : kind === "png" ? "png" : "jpg"}`;
}
