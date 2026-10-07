export function providerObject(body:any){
 if(body?.stop_reason==='refusal'||body?.stop_reason==='max_tokens'||body?.error)throw Error('provider_reply_invalid');
 const text=(Array.isArray(body?.content)?body.content:[]).filter((c:any)=>c?.type==='text'&&typeof c.text==='string').map((c:any)=>c.text).join('').trim();
 const value=JSON.parse(text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('provider_reply_invalid');
 return value;
}
export const CLASS_CODES=new Set(['COORDINATOR','DOOR_CLOSER','EDGE_GUARD','EXIT_DEVICE','EXTERIOR','FLUSH_BOLT','FLUSH_PULL','HINGE_BUTT','HINGE_CONT','LATCH_CATCH_BOLT','LOCKSET','PIVOT','PROTECTION_PLATE','PULL_PUSH','RESCUE','STOP_HOLDER','VANDAL_TRIM','ELECTRIC_STRIKE','POWER_TRANSFER']);
export function classifierObject(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.prototype.hasOwnProperty.call(value,'component_class'))throw Error('classifier_reply_invalid');
 const code=value.component_class;
 if(code!==null&&(typeof code!=='string'||!CLASS_CODES.has(code.trim().toUpperCase().replace(/[ -]+/g,'_'))))throw Error('classifier_class_invalid');
 return {...value,component_class:code===null?null:code.trim().toUpperCase().replace(/[ -]+/g,'_')};
}
