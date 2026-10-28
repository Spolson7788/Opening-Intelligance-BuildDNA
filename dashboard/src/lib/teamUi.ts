// M5: pure helpers for the Team page (unit-tested without a browser).
export type AddMode = "password" | "invite";
export const EMAIL_NOT_CONFIGURED = "Email not configured, invite not sent.";

/** The test-account box defaults on for reserved .invalid addresses; the admin can always change it. */
export function defaultTestAccount(email: string): boolean {
  return /\.invalid$/i.test(email.trim());
}

export function inviteSendMessage(status: "pending" | "sent" | "not_configured" | "failed", email: string): { tone: "ok" | "warn" | "error"; text: string } {
  if (status === "sent") return { tone: "ok", text: `Invite emailed to ${email}.` };
  if (status === "not_configured") return { tone: "warn", text: `${EMAIL_NOT_CONFIGURED} The invite is saved; resend it once email is set up, or add the person with a temporary password instead.` };
  return { tone: "error", text: "The invite is saved but the email could not be sent. Try Resend in a few minutes." };
}

export function teamErrorMessage(code: string | undefined, retryAfterSeconds?: number): string {
  switch (code) {
    case "email_already_registered": return "That email is already registered.";
    case "invite_pending": return "There is already an open invite for that email. Resend or revoke it below.";
    case "admin_required": return "Only admins can add team members.";
    case "role_above_creator": return "You can't create a role above your own.";
    case "default_property_not_accessible": return "That facility isn't available to your organization.";
    case "password_too_short": return "Temporary password needs at least 12 characters.";
    case "password_too_long": return "Temporary password can be at most 72 characters.";
    case "invite_rate_limited": return `Too many invite emails right now. Try again in ${Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60))} minute(s).`;
    case "invite_closed": return "That invite was already accepted or revoked.";
    default: return "Couldn't save. Check your connection and try again.";
  }
}

export function inviteStatusLabel(i: { email_status: string; expired?: boolean }): string {
  if (i.expired) return "Expired";
  return { sent: "Emailed", not_configured: "Not sent (email not configured)", failed: "Email failed", pending: "Pending" }[i.email_status] ?? i.email_status;
}
/** The token lives in the URL fragment (#invite=...), which browsers never send to servers. */
export function readInviteToken(hash: string): string | null {
  const m = /(?:^#|&)invite=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
  return m ? m[1] : null;
}
