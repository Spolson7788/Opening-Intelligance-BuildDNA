// M5: pluggable outbound email. One provider today: Resend (HTTPS JSON API).
// Configured ONLY through environment variables (values are never logged):
//   EMAIL_PROVIDER          "resend" (anything else, or unset, = not configured)
//   EMAIL_PROVIDER_API_KEY  provider API key
//   EMAIL_FROM              verified sender, e.g. "Opening Intelligence <invites@example.com>"
//   APP_BASE_URL            public origin used to build links, e.g. https://example.netlify.app
// Nothing here logs recipients, bodies, links, keys or provider responses.
export interface EmailAttachment { filename: string; contentBase64: string }
export interface OutboundEmail { to: string | string[]; subject: string; text: string; html: string; attachments?: EmailAttachment[] }
export type SendOutcome = { sent: true } | { sent: false; reason: "email_not_configured" | "email_send_failed" };
export interface EmailProvider { readonly name: string; send(msg: OutboundEmail): Promise<SendOutcome> }
type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const REPORT_EMAIL_NAMES = ["EMAIL_PROVIDER", "EMAIL_PROVIDER_API_KEY", "EMAIL_FROM", "APP_BASE_URL", "RESEND_API_KEY", "PASSWORD_RESET_FROM_EMAIL", "PASSWORD_RESET_PUBLIC_URL"] as const;

function httpsOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function emailSettings(env: Env = process.env) {
  const provider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = env.EMAIL_PROVIDER_API_KEY ?? "";
  const from = (env.EMAIL_FROM ?? "").trim();
  const baseUrl = (env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const validBase = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(baseUrl) || /^http:\/\/localhost(:\d+)?$/i.test(baseUrl);
  const configured = provider === "resend" && apiKey.length > 0 && from.includes("@") && validBase;
  // Report presence only, never values.
  return { configured, provider: provider || null, hasApiKey: apiKey.length > 0, hasFrom: from.length > 0, hasBaseUrl: validBase, baseUrl: validBase ? baseUrl : null, from };
}

export function resendProvider(apiKey: string, from: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): EmailProvider {
  return {
    name: "resend",
    async send(msg) {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from, to: Array.isArray(msg.to) ? msg.to : [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
            ...(msg.attachments?.length ? { attachments: msg.attachments.map((file) => ({ filename: file.filename, content: file.contentBase64 })) } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { sent: true };
        console.error("OI email", { provider: "resend", outcome: "rejected", status: res.status });
        return { sent: false, reason: "email_send_failed" };
      } catch {
        console.error("OI email", { provider: "resend", outcome: "unreachable" });
        return { sent: false, reason: "email_send_failed" };
      }
    },
  };
}

const notConfigured: EmailProvider = { name: "none", send: async () => ({ sent: false, reason: "email_not_configured" }) };

let override: EmailProvider | null = null;
/** Tests only. */
export function setEmailProviderForTests(p: EmailProvider | null) { override = p; }
export async function sendEmail(msg: OutboundEmail): Promise<SendOutcome> {
  return getEmailProvider().send(msg);
}

export function reportLinkBase(env: Env = process.env): string | null {
  return emailSettings(env).baseUrl || httpsOrigin(env.PASSWORD_RESET_PUBLIC_URL);
}

// Inspection reports use the invite mail settings when those are complete.
// Otherwise they use the password-reset sender already configured on staging.
// The result lists variable names only, never values.
export function reportEmailBlockers(env: Env = process.env): string[] {
  if (getEmailProvider(env).name !== "none") return [];
  const settings = emailSettings(env);
  const missing: string[] = [];
  if (settings.provider !== "resend") missing.push("EMAIL_PROVIDER");
  if (!settings.hasApiKey) missing.push("EMAIL_PROVIDER_API_KEY");
  if (!settings.hasFrom || !(env.EMAIL_FROM ?? "").includes("@")) missing.push("EMAIL_FROM");
  if (!settings.hasBaseUrl) missing.push("APP_BASE_URL");
  if (!(env.RESEND_API_KEY ?? "").trim()) missing.push("RESEND_API_KEY");
  if (!(env.PASSWORD_RESET_FROM_EMAIL ?? "").includes("@")) missing.push("PASSWORD_RESET_FROM_EMAIL");
  if (!httpsOrigin(env.PASSWORD_RESET_PUBLIC_URL)) missing.push("PASSWORD_RESET_PUBLIC_URL");
  return missing.filter((name) => (REPORT_EMAIL_NAMES as readonly string[]).includes(name));
}

export function getEmailProvider(env: Env = process.env): EmailProvider {
  if (override) return override;
  const s = emailSettings(env);
  if (s.configured) return resendProvider(env.EMAIL_PROVIDER_API_KEY as string, s.from);
  const key = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.PASSWORD_RESET_FROM_EMAIL ?? "").trim();
  if (key && from.includes("@")) return resendProvider(key, from);
  return notConfigured;
}