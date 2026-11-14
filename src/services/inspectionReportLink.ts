// Sign-in link for a fire door inspection. The path is the dashboard opening
// page. There is no token, query string, or public file address.
export function dashboardInspectionLink(baseUrl: string | null, openingId: string, inspectionId: string): string | null {
  if (!baseUrl) return null;
  if (!/^[0-9a-f-]{36}$/i.test(openingId) || !/^[0-9a-f-]{36}$/i.test(inspectionId)) return null;
  return `${baseUrl}/dashboard/opening/${openingId}#inspection-${inspectionId}`;
}
