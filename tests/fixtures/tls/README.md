# Public provider CA fixture

Downloaded from the SSL configuration download link in the authenticated
Supabase dashboard for staging project ioqfdcehnhnqpnqawwvo on 2026-09-21.
Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
File SHA256: 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
DER SHA256 fingerprint: 807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa

This is a public CA certificate, not a key. Runtime trust is supplied through
DATABASE_CA_CERT to Postgres only; this test fixture is not a runtime default.
