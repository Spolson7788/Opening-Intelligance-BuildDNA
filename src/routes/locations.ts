import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const locationsRouter = Router();
locationsRouter.use(requireAuth);

locationsRouter.get("/states", async (_req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      "SELECT code, name, fips FROM us_states ORDER BY name"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

locationsRouter.get("/counties", async (req: AuthedRequest, res) => {
  const stateCode = typeof req.query.state_code === "string" ? req.query.state_code.toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(stateCode)) {
    return res.status(400).json({ error: "state_code is required" });
  }
  try {
    const result = await pool.query(
      `SELECT fips, state_code, name FROM us_counties
       WHERE state_code = $1 ORDER BY name`,
      [stateCode]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
