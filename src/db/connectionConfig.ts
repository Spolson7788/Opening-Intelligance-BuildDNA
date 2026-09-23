import { X509Certificate } from "node:crypto";
import type { PoolConfig } from "pg";

export function databaseTargetDescriptor(connectionString: string | undefined): string {
  if (!connectionString) return "not-configured";
  try {
    const url = new URL(connectionString);
    const hostname = url.hostname.toLowerCase();
    const supabaseMatch = hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (supabaseMatch) return `supabase:${supabaseMatch[1]}`;
    if (/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname)) {
      const poolerMatch = decodeURIComponent(url.username).match(/\.([a-z0-9]+)$/);
      if (poolerMatch) return `supabase:${poolerMatch[1]}`;
      return "supabase:pooler-project-unresolved";
    }
    return `host:${hostname}`;
  } catch {
    return "invalid-url";
  }
}

// A provider CA is optional for existing deployments and local databases.
// When supplied, trust it only for Postgres and retain certificate/host checks.
export function databaseConnectionConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const connectionString = env.DATABASE_URL;
  const ca = env.DATABASE_CA_CERT;
  if (!ca) return { connectionString };
  try {
    if (!new X509Certificate(ca).ca) throw new Error();
  } catch {
    throw new Error("database_ca_certificate_invalid");
  }
  if (!connectionString) throw new Error("database_url_required_for_ca");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("database_url_invalid");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("database_url_protocol_invalid");
  }
  // pg reparses the URL after merging options. Leaving sslmode in that URL
  // would replace our explicit CA configuration with an empty SSL object.
  const modes = url.searchParams.getAll("sslmode");
  if (modes.some(mode => mode !== "verify-full") || modes.length > 1 ||
      ["ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"].some(key => url.searchParams.has(key))) {
    throw new Error("database_tls_configuration_conflict");
  }
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}
