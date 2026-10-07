import {pool} from '../../src/db/pool';
import {requireReferenceStagingRuntime} from '../../scripts/reference/preview-context.mjs';
import type { Config, Context } from "@netlify/functions";
import { processPhotoDeletionJobs } from "../../src/routes/photos";

export default async (_request: Request, context: Context) => {
  try { requireReferenceStagingRuntime(context, pool.options.connectionString, (key: string) => (globalThis as any).Netlify?.env?.get(key)); }
  catch { return new Response(null, {status:503}); }
  const result = await processPhotoDeletionJobs({ limit: 25 });
  console.log(JSON.stringify({ event: "photo_deletion_retry", ...result }));
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: "* * * * *",
};
