import type { Config } from "@netlify/functions";
import { processPhotoDeletionJobs } from "../../src/routes/photos";

export default async () => {
  const result = await processPhotoDeletionJobs({ limit: 25 });
  console.log(JSON.stringify({ event: "photo_deletion_retry", ...result }));
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: "* * * * *",
};
