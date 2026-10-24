import type { Config, Context } from "@netlify/functions";
import { createApp } from "../../src/app";
import { recoveryDeploymentAllowed } from "../../src/services/recoveryDeployment";
import { netlifyExpressAdapter } from "./_shared/expressAdapter";

export default async (request: Request, context: Context): Promise<Response> => {
  const app = createApp({
    accountRecoveryEnabled: recoveryDeploymentAllowed(context),
    // SQL metadata-write denial alone does not prevent legacy presigned uploads.
    legacyDocumentsEnabled: context?.site?.id !== "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b",
  });
  return netlifyExpressAdapter(app)(request);
};

export const config: Config = {
  path: ["/health", "/api/*"],
};
