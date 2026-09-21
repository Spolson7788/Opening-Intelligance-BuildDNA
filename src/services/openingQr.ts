/** Canonical configured target; never infer a QR authority from request headers. */
export function openingQrUrl(token: string): string {
  const configured = process.env.OI_FIELD_APP_URL;
  if (!configured) throw new Error("field_app_url_not_configured");
  const base = new URL(configured);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("invalid_field_app_url");
  }
  base.pathname = base.pathname.replace(/\/?$/, "/");
  return new URL(`opening/by-qr/${encodeURIComponent(token)}`, base).href;
}
