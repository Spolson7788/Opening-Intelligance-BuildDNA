import { Pool, types } from "pg";
import dotenv from "dotenv";
import { databaseConnectionConfig, databaseTargetDescriptor } from "./connectionConfig";

dotenv.config();

// node-postgres returns NUMERIC/DECIMAL columns as strings by default, to
// avoid silent precision loss on values too large for a JS number. None of
// our NUMERIC columns (health_score, lat/long, cost) are ever in that range,
// and returning them as strings breaks client-side arithmetic in ways that
// don't show up in type-checking — e.g. summing health scores across
// openings does string concatenation instead of addition, and sorting by
// health score does lexicographic string comparison instead of numeric
// (so "9.00" sorts after "80.00"). Both bugs were caught by actually
// running seeded data through the real API, not by tsc.
// OID 1700 = numeric/decimal.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

// Expects DATABASE_URL env var, e.g.
// postgres://user:password@localhost:5432/opening_intel
console.info("Database target", databaseTargetDescriptor(process.env.DATABASE_URL));
export const pool = new Pool(databaseConnectionConfig(process.env));

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});
