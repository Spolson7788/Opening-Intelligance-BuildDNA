/** Calendar day for a stored YYYY-MM-DD or an instant, shown without shifting the stored day. */
export function formatStoredCalendarDay(value: string): string {
  const raw = String(value);
  const day = raw.slice(0, 10);
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(day) && (raw.length === 10 || raw[10] === "T")
    ? new Date(`${day}T00:00:00Z`)
    : new Date(raw);
  if (Number.isNaN(instant.getTime())) return raw;
  return instant.toLocaleDateString(undefined, { timeZone: "UTC" });
}

/** The calendar day in `timeZone`, or on this device when the zone is omitted. */
export function localCalendarDay(now = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
