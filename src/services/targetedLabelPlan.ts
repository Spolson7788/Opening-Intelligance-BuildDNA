import type {LabelRegion} from './labelReading';
// Give reading its own clock after originals are prepared, while reserving
// classifier and persistence time inside the synchronous function budget.
export function targetedLabelDeadline(started:number,now=Date.now()){
 return Math.min(started+43_000,now+32_000);
}

// A sticker/model label and a separate maker mark take priority over fallback
// search areas. No brand/model names or development-photo indices enter this plan.
export function targetedLabelPlan(regions:LabelRegion[]):LabelRegion[] {
 const labels=regions.filter(r=>r.kind!=='brand_mark'&&r.kind!=='search_tile');
 const marks=regions.filter(r=>r.kind==='brand_mark');
 labels.sort((a,b)=>Number(b.kind==='product_label')-Number(a.kind==='product_label'));
 return [...labels.slice(0,1),...marks.slice(0,1),...labels.slice(1),...marks.slice(1)].slice(0,3);
}

export function targetedReaderCanStart(deadline:number,now=Date.now()):boolean {
 // Do not start a potentially billed reader with the baseline's 6.7s headroom.
 return deadline-now>=12_000;
}
