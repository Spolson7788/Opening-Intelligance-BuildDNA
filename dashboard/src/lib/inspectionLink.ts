export function linkedInspectionId(hash: string): string | null {
  const match = /^#inspection-([0-9a-f-]{36})$/i.exec(hash);
  return match ? match[1] : null;
}
