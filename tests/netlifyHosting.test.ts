import { describe, expect, it } from "vitest";
import apiHandler, { config as apiConfig } from "../netlify/functions/api";
import { config as retryConfig } from "../netlify/functions/photo-deletion-retry";

describe("nonproduction hosting package", () => {
  it("executes the API health route through the Netlify Request adapter", async () => {
    const response = await apiHandler(new Request("https://example.invalid/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(apiConfig.path).toEqual(["/health", "/api/*"]);
  });

  it("declares the bounded deletion retry schedule", () => {
    expect(retryConfig.schedule).toBe("* * * * *");
  });
});
