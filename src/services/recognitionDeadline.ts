// Bound optional work without discarding an already usable photo analysis.
export async function withinRecognitionBudget<T>(work:Promise<T>|((signal:AbortSignal)=>Promise<T>),deadline:number,fallback:()=>T):Promise<T>{
 const controller=new AbortController();
 const promise=typeof work==='function'?work(controller.signal):work;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<T>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fallback());},Math.max(0,deadline-Date.now()));})]);}
 finally{if(timer)clearTimeout(timer);}
}

// Reserve recording time and avoid starting paid work too close to the deadline.
export function referenceComparisonBudget(started:number,now=Date.now()){
 const remaining=started+52000-now-3000;
 return remaining>=6000?Math.min(26000,remaining):0;
}

export function recognitionRunInterrupted(run:{status:string;created_at:string|Date},now=Date.now()){
 const created=new Date(run.created_at).getTime();
 return run.status==='running'&&Number.isFinite(created)&&now-created>90_000;
}
