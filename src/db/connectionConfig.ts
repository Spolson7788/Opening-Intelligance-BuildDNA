import { X509Certificate } from "node:crypto";
import type { PoolConfig } from "pg";

// Public Supabase Root 2021 CA downloaded from the staging project.
// SHA-256: 807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa
// Used only for the designated staging database; never contains credentials.
const REFERENCE_STAGING_CA = "-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n";
const REFERENCE_STAGING_TARGET = "supabase:ioqfdcehnhnqpnqawwvo";

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
  const ca = databaseTargetDescriptor(connectionString) === REFERENCE_STAGING_TARGET
    ? REFERENCE_STAGING_CA
    : env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
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
