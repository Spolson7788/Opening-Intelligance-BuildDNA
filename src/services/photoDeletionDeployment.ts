const HELD_SITE = "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b";

// Require the platform's site identity; missing/conflicting identity must not
// accidentally enable a destructive scheduled worker on restricted staging.
export function photoDeletionDeploymentAllowed(
  context?: { site?: { id?: string } },
  configuredSite = process.env.SITE_ID,
): boolean {
  const site = context?.site?.id;
  return Boolean(site && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(site) && site !== HELD_SITE &&
    (!configuredSite || configuredSite === site));
}
