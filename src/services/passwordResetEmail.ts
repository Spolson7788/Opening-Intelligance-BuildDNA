// Account recovery requires an email provider. Never display or log a reset link.
export function passwordResetConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.PASSWORD_RESET_FROM_EMAIL && process.env.PASSWORD_RESET_PUBLIC_URL);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  if (!passwordResetConfigured()) throw new Error("password_reset_email_unconfigured");
  const base = new URL(process.env.PASSWORD_RESET_PUBLIC_URL!);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("password_reset_public_url_invalid");
  }
  // Fragment never reaches the web server in an HTTP request or ordinary access log.
  const url = new URL("dashboard/reset-password", base);
  url.hash = `token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.PASSWORD_RESET_FROM_EMAIL,
      to: [to],
      subject: "Reset your Opening Intelligence password",
      text: `Use this link to reset your Opening Intelligence password. It expires in 30 minutes and works once.\n\n${url.href}\n\nIf you didn't request this, ignore this email.`,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("password_reset_email_delivery_failed");
}

export async function sendPasswordChangedEmail(to: string): Promise<void> {
  if (!passwordResetConfigured()) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.PASSWORD_RESET_FROM_EMAIL,
      to: [to],
      subject: "Your Opening Intelligence password was changed",
      text: "Your Opening Intelligence password was changed. If this wasn't you, contact your account administrator immediately.",
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("password_changed_email_delivery_failed");
}
