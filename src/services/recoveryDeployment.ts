// Recovery still requires an operator-issued, expiring, single-use code.
// These are the two explicitly authorized private validation deployments.
export function recoveryDeploymentAllowed(context?: {site?:{id?:string};deploy?:{context?:string}}): boolean {
 const site=context?.site?.id, deployment=context?.deploy?.context;
 return (site==='6430c57d-8a98-43bc-ba25-94007dd244f2' && deployment==='deploy-preview') ||
   (site==='80fbbee8-b9d3-4b16-b93f-d2d8396591ec' && deployment==='production');
}
