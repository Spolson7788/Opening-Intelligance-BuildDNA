import request from "supertest";
import { describe, expect, it, afterEach } from "vitest";
import { createApp } from "../src/app";
import { setReportImageLoaderForTests } from "../src/services/nfpa80Report";

afterEach(() => {
  setReportImageLoaderForTests();
});

describe("api startup without sharp", () => {
  it("creates the app and loads health and login when sharp import throws", async () => {
    setReportImageLoaderForTests(async () => {
      throw new Error("sharp native missing");
    });
    const app = createApp();
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });
    const login = await request(app).post("/api/auth/login").send({});
    expect(login.status).toBe(400);
    expect(login.body.error).toBe("invalid_login_request");
  });
});
