import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";

const connect = vi.hoisted(() => vi.fn().mockRejectedValue(new Error("sensitive connection details")));
vi.mock("../src/db/pool", () => ({ pool: { connect } }));
import { authRouter } from "../src/routes/auth";

it("returns a controlled 503 when signup cannot connect, without leaking the error", async () => {
  const app = express();
  app.use(express.json(), authRouter);
  const result = await request(app).post("/signup").send({
    organization_name: "Synthetic TLS test", full_name: "Test admin",
    email: "tls-test@oi-nonprod.invalid", password: "local-test-only",
  });
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ error: "database_unavailable" });
  expect(connect).toHaveBeenCalledTimes(1);
});
