const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only a bare legacy token or a configured canonical Field route is a scan. */
export function parseOpeningQr(text: string, fieldBase: string): string | null {
  if (tokenPattern.test(text)) return text;
  if (text !== text.trim() || /[\\\s]/.test(text)) return null;
  try {
    const base = new URL(fieldBase), url = new URL(text);
    const prefix = base.pathname.replace(/\/?$/, "/") + "opening/by-qr/";
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) return null;
    const token = url.pathname.slice(prefix.length);
    return tokenPattern.test(token) ? token : null;
  } catch { return null; }
}

export function loginReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\s?#]/.test(value) || value === "/login") return "/scan";
  return value;
}
