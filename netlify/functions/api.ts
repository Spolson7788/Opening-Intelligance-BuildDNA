import type { Config, Context } from "@netlify/functions";
import { createApp } from "../../src/app";
import { recoveryDeploymentAllowed } from "../../src/services/recoveryDeployment";
import { netlifyExpressAdapter } from "./_shared/expressAdapter";

export default async (request: Request, context: Context): Promise<Response> => {
  const app = createApp({ accountRecoveryEnabled: recoveryDeploymentAllowed(context) });
  return netlifyExpressAdapter(app)(request);
};

export const config: Config = {
  path: ["/health", "/api/*"],
};
