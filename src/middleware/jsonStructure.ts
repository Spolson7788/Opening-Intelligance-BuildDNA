import type {RequestHandler} from 'express';

// The existing 10 MB byte cap permits photo payloads, but alone does not bound
// collection validation work. Preserve the API's 1,000-row bulk import ceiling.
export const JSON_STRUCTURE_LIMITS = {collection:1000, depth:32, nodes:100000} as const;
export function withinJsonStructureLimits(value:unknown):boolean {
 const pending:Array<{value:unknown;depth:number}>=[{value,depth:0}];let nodes=0;
 while(pending.length){
  const item=pending.pop()!;
  if(++nodes>JSON_STRUCTURE_LIMITS.nodes||item.depth>JSON_STRUCTURE_LIMITS.depth)return false;
  if(!item.value||typeof item.value!=='object')continue;
  const values=Array.isArray(item.value)?item.value:Object.values(item.value);
  if(values.length>JSON_STRUCTURE_LIMITS.collection)return false;
  if(nodes+pending.length+values.length>JSON_STRUCTURE_LIMITS.nodes)return false;
  for(const child of values)pending.push({value:child,depth:item.depth+1});
 }
 return true;
}
export const enforceJsonStructure:RequestHandler=(req,res,next)=>{
 if(!withinJsonStructureLimits(req.body)){
  res.status(413).json({error:'request_structure_limit_exceeded'});return;
 }
 next();
};
