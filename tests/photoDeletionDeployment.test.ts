import {afterEach, expect, it, vi} from "vitest";
import {photoDeletionDeploymentAllowed} from "../src/services/photoDeletionDeployment";
import handler, {config} from "../netlify/functions/photo-deletion-retry";

const probes = vi.hoisted(() => ({loaded:vi.fn(), process:vi.fn(async () => ({processed:0}))}));
vi.mock("../src/routes/photos", () => {
  probes.loaded();
  return {processPhotoDeletionJobs:probes.process};
});
afterEach(() => vi.unstubAllEnvs());
const held="b64bf33c-a131-4ae2-b2b0-9aec16e9f77b";
const existing="80fbbee8-b9d3-4b16-b93f-d2d8396591ec";
const request=new Request("https://example.invalid/");

it("does not load or invoke database/storage processing for held, missing or conflicting identity", async () => {
  for (const [site, configured] of [[held,held],[held,existing],[held,""],[held.toUpperCase(),""],[undefined,held],[undefined,""],["", ""],["unknown",""],[" ",""],[existing,held]]) {
    vi.stubEnv("SITE_ID",configured!);
    const context=site===undefined ? undefined : {site:{id:site}};
    expect(photoDeletionDeploymentAllowed(context)).toBe(false);
    const response=await handler(request, context as Parameters<typeof handler>[1]);
    expect(response.status).toBe(204);
  }
  expect(probes.loaded).not.toHaveBeenCalled();
  expect(probes.process).not.toHaveBeenCalled();
});

it("preserves bounded processing on an identified existing site", async () => {
  vi.stubEnv("SITE_ID",existing);
  expect(photoDeletionDeploymentAllowed({site:{id:existing}})).toBe(true);
  expect(photoDeletionDeploymentAllowed({site:{id:existing}},"")).toBe(true);
  const response=await handler(request,{site:{id:existing}} as Parameters<typeof handler>[1]);
  expect(response.status).toBe(204);
  expect(probes.process).toHaveBeenCalledExactlyOnceWith({limit:25});
  expect(config.schedule).toBe("* * * * *");
});
