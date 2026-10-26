// Staging-only capabilities; no default financial activation or other-site expansion.
export function stagingInputCapabilities(context?:{site?:{id?:string};deploy?:{context?:string}},env:Record<string,string|undefined>=process.env){
 const allowed=context?.site?.id==='b64bf33c-a131-4ae2-b2b0-9aec16e9f77b'&&context?.deploy?.context==='production';
 return {providerEstimates:allowed&&env.OI_PROVIDER_ESTIMATES_ENABLED==='true',facilityBudget:allowed&&env.OI_FACILITY_BUDGET_ENABLED==='true'};
}
