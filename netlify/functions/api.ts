import {retainedRecoveryWindow} from '../../src/services/retainedDocumentRecovery';
import {stagingInputCapabilities} from '../../src/services/stagingInputCapabilities';
import {createSupabaseCommercialStore} from '../../src/services/supabaseCommercialStorage';
import {runtimeStorageIdentity} from '../../src/services/storageTechnicalIdentity';
import type { Config, Context } from "@netlify/functions";
import { createApp } from "../../src/app";
import { recoveryDeploymentAllowed } from "../../src/services/recoveryDeployment";
import { netlifyExpressAdapter } from "./_shared/expressAdapter";

export default async (request: Request, context: Context): Promise<Response> => {
  const capabilities=stagingInputCapabilities(context);
  let commercialStore;
  if(capabilities.providerEstimates&&new URL(request.url).pathname.startsWith('/api/commercial/')){try{commercialStore=await createSupabaseCommercialStore({enabled:true,apiKey:process.env.OI_COMMERCIAL_STORAGE_API_KEY||'',getAccessToken:()=>runtimeStorageIdentity().getAccessToken()});}catch{/* Fixed unavailable state; never log provider errors or credentials. */}}
  const app = createApp({
    retainedDocumentRecoveryAllowed:()=>retainedRecoveryWindow(context,process.env),
    commercialStore,
    commercialInputsOnly:context?.site?.id==='b64bf33c-a131-4ae2-b2b0-9aec16e9f77b',
    commercialInputsEnabled:capabilities.providerEstimates&&!!commercialStore,
    facilityBudgetEnabled:capabilities.facilityBudget,
    accountRecoveryEnabled: recoveryDeploymentAllowed(context),
    // SQL metadata-write denial alone does not prevent legacy presigned uploads.
    // Fail closed: any site other than the two staging sites (e.g. production) gets
    // no recognition, reference library or recognition usage/billing endpoints.
    recognitionFeaturesEnabled:['b64bf33c-a131-4ae2-b2b0-9aec16e9f77b','80fbbee8-b9d3-4b16-b93f-d2d8396591ec'].includes(context?.site?.id??''),
    legacyDocumentsEnabled: context?.site?.id !== "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b",
  });
  return netlifyExpressAdapter(app)(request);
};

export const config: Config = {
  path: ["/health", "/api/*"],
};
