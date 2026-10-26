// Recovery still requires an operator-issued, expiring, single-use code.
// Exact private validation deployments only; code issuance remains operator-only.
export function recoveryDeploymentAllowed(context?: {site?:{id?:string};deploy?:{context?:string}}): boolean {
 const site=context?.site?.id, deployment=context?.deploy?.context;
 return (site==='6430c57d-8a98-43bc-ba25-94007dd244f2' && deployment==='deploy-preview') ||
   (site==='80fbbee8-b9d3-4b16-b93f-d2d8396591ec' && deployment==='production') ||
   (site==='b64bf33c-a131-4ae2-b2b0-9aec16e9f77b' && deployment==='production');
}
