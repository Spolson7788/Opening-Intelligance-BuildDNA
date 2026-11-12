// Recognition and the Measure reader share one site gate.
// The two staging sites stay on, as they are today.
// Production is on the list only while both launch flags are set, so a deploy
// without those flags still leaves the routes off.
// Every other site id is refused, even when the flags are set.

export const STAGING_RECOGNITION_SITE_IDS = [
  "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b",
  "80fbbee8-b9d3-4b16-b93f-d2d8396591ec",
] as const;

export const PRODUCTION_RECOGNITION_SITE_ID = "b4e0fc62-86ce-4a26-9ebf-26d7386f4b01";

export function recognitionFeaturesEnabledForSite(
  siteId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = siteId ?? "";
  if ((STAGING_RECOGNITION_SITE_IDS as readonly string[]).includes(id)) return true;
  if (id !== PRODUCTION_RECOGNITION_SITE_ID) return false;
  return env.OI_RECOGNITION_ENABLED === "true" && env.OI_MEASUREMENT_READER === "anthropic";
}
