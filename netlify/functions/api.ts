import {pool} from '../../src/db/pool';
import {requireReferenceStagingRuntime} from '../../scripts/reference/preview-context.mjs';
import type { Config, Context } from "@netlify/functions";
import { createApp } from "../../src/app";
import { recoveryDeploymentAllowed } from "../../src/services/recoveryDeployment";
import { netlifyExpressAdapter } from "./_shared/expressAdapter";
import {stabilityRuntime} from '../../src/services/recognitionStabilityBudget';

export default async (request: Request, context?: Context): Promise<Response> => {
  try { requireReferenceStagingRuntime(context, pool.options.connectionString, (key: string) => (globalThis as any).Netlify?.env?.get(key)); }
  catch { return Response.json({error:'reference_staging_not_configured'}, {status:503}); }
  const app = createApp({ accountRecoveryEnabled: recoveryDeploymentAllowed(context) });
  return stabilityRuntime.run(context?.deploy?.context, () => netlifyExpressAdapter(app)(request));
};

export const config: Config = {
  path: ["/health", "/api/*"],
};
