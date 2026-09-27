export function recoveryDeploymentAllowed(context?: {site?:{id?:string};deploy?:{context?:string}}): boolean {
 return context?.site?.id==='6430c57d-8a98-43bc-ba25-94007dd244f2' && context?.deploy?.context==='deploy-preview';
}
