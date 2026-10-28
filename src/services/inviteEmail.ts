// M5: invite email template (plain text + HTML). The accept link carries the token in
// the URL fragment (#invite=...) so it never reaches server or proxy logs or Referer headers.
export const APP_NAME = "Opening Intelligence";
export function acceptInviteUrl(baseUrl: string, token: string) {
  return `${baseUrl.replace(/\/+$/, "")}/dashboard/accept-invite#invite=${encodeURIComponent(token)}`;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const ROLE_LABEL: Record<string, string> = { admin: "Admin", facilities_manager: "Facilities manager", technician: "Technician", inspector: "Inspector", viewer: "Viewer" };
export function inviteEmail(p: { to: string; inviteeName: string; inviterName: string; organizationName: string; role: string; acceptUrl: string; expiresAt: Date }) {
  const role = ROLE_LABEL[p.role] ?? p.role;
  const expires = p.expiresAt.toUTCString();
  const subject = `${p.inviterName} invited you to ${p.organizationName} on ${APP_NAME}`;
  const text = [
    `Hi ${p.inviteeName},`, "",
    `${p.inviterName} invited you to join ${p.organizationName} on ${APP_NAME} as ${role}.`, "",
    "Accept the invite and choose your password:", p.acceptUrl, "",
    `This link works once and expires ${expires}.`,
    "If you weren't expecting this, ignore this email; no account is created unless you accept.", "",
    `- ${APP_NAME}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5">
<p>Hi ${esc(p.inviteeName)},</p>
<p><strong>${esc(p.inviterName)}</strong> invited you to join <strong>${esc(p.organizationName)}</strong> on ${APP_NAME} as ${esc(role)}.</p>
<p><a href="${esc(p.acceptUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept invite and choose a password</a></p>
<p style="font-size:13px;color:#52606d">Or paste this link into your browser:<br>${esc(p.acceptUrl)}</p>
<p style="font-size:13px;color:#52606d">This link works once and expires ${esc(expires)}. If you weren't expecting this, ignore this email; no account is created unless you accept.</p>
<p>- ${APP_NAME}</p></body></html>`;
  return { subject, text, html };
}