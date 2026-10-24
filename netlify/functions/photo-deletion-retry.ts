import type { Config, Context } from "@netlify/functions";
import { photoDeletionDeploymentAllowed } from "../../src/services/photoDeletionDeployment";

export default async (_request: Request, context: Context) => {
  if (!photoDeletionDeploymentAllowed(context)) return new Response(null, { status: 204 });
  // Do not even load database/storage dependencies while this worker is held.
  const { processPhotoDeletionJobs } = await import("../../src/routes/photos");
  const result = await processPhotoDeletionJobs({ limit: 25 });
  console.log(JSON.stringify({ event: "photo_deletion_retry", ...result }));
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: "* * * * *",
};
