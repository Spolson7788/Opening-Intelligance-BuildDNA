import { describe, expect, it } from "vitest";
import apiHandler, { config as apiConfig } from "../netlify/functions/api";
import { config as retryConfig } from "../netlify/functions/photo-deletion-retry";

describe("nonproduction hosting package", () => {
  it("holds all legacy document routes on the restricted site before issuing upload URLs", async () => {
    const context = {site:{id:"b64bf33c-a131-4ae2-b2b0-9aec16e9f77b"}} as Parameters<typeof apiHandler>[1];
    for (const path of ["/api/documents/presign", "/api/documents", "/API/DOCUMENTS/presign/"]) {
      const response = await apiHandler(new Request(`https://example.invalid${path}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({content_type:"application/pdf"})}),context);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({error:"documents_unavailable"});
    }
    const previousSite = {site:{id:"80fbbee8-b9d3-4b16-b93f-d2d8396591ec"}} as Parameters<typeof apiHandler>[1];
    const previousResponse=await apiHandler(new Request("https://example.invalid/api/documents/presign",{method:"POST"}),previousSite);
    expect(previousResponse.status).toBe(401);
  });
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
