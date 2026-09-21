import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { databaseConnectionConfig } from "../src/db/connectionConfig";

const ca = readFileSync(resolve("tests/fixtures/tls/supabase-prod-ca-2021.crt"), "utf8");
const url = "postgresql://test:private@db.example.test:6543/postgres?sslmode=verify-full&application_name=test";

describe("Postgres certificate trust", () => {
  it("preserves existing configurations when no explicit CA is supplied", () => {
    expect(databaseConnectionConfig({ DATABASE_URL: url })).toEqual({ connectionString: url });
  });
  it("retains the CA and peer verification after pg parses the URL", () => {
    const config = databaseConnectionConfig({ DATABASE_URL: url, DATABASE_CA_CERT: ca });
    const client = new Client(config);
    const ssl = (client as any).connectionParameters.ssl;
    expect(ssl.ca).toBe(ca);
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity).toBeUndefined(); // Node's hostname verifier remains in effect.
    expect(new URL(config.connectionString!).searchParams.get("application_name")).toBe("test");
  });
  it.each(["disable", "no-verify", "verify-ca", "require"])("refuses conflicting mode %s", mode => {
    expect(() => databaseConnectionConfig({ DATABASE_URL: url.replace("verify-full", mode), DATABASE_CA_CERT: ca })).toThrow("database_tls_configuration_conflict");
  });
  it.each(["ssl=false", "sslrootcert=other.crt", "uselibpqcompat=true", "sslmode=verify-full"])("refuses competing URL parameter %s", parameter => {
    expect(() => databaseConnectionConfig({ DATABASE_URL: `${url}&${parameter}`, DATABASE_CA_CERT: ca })).toThrow("database_tls_configuration_conflict");
  });
  it("refuses invalid CA without including credentials in the error", () => {
    expect(() => databaseConnectionConfig({ DATABASE_URL: url, DATABASE_CA_CERT: "not a certificate" })).toThrow("database_ca_certificate_invalid");
  });
});
