// Bound optional work without discarding an already usable photo analysis.
export async function withinRecognitionBudget<T>(work:Promise<T>,deadline:number,fallback:()=>T):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback()),Math.max(0,deadline-Date.now()));})]);}
 finally{if(timer)clearTimeout(timer);}
}
