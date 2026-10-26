import {z} from 'zod';
export const money=z.number().int().min(0).max(1_000_000_000);
export const laborSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('fixed'),amount_minor:money.nullable()}).strict(),
 z.object({kind:z.literal('hourly'),rate_minor:money.nullable(),minutes:z.number().int().min(0).max(100000).nullable()}).strict(),
 z.object({kind:z.literal('per_sku_hourly'),rate_minor:money.nullable()}).strict(),
]);
export function estimateTotals(parts:Array<{quantity:number;unit_price_minor:number|null;catalog?:{unit_label?:string|null;installation_minutes_per_unit?:number|null}}>,labor:z.infer<typeof laborSchema>,tax:number|null,fees:number|null){
 const missing:string[]=[];let subtotal=0n;
 parts.forEach((p,i)=>{if(p.unit_price_minor===null)missing.push('part_'+(i+1)+'_price');else subtotal+=BigInt(p.quantity)*BigInt(p.unit_price_minor);});
 let laborValue:bigint|null=null;
 if(labor.kind==='fixed'){if(labor.amount_minor!==null)laborValue=BigInt(labor.amount_minor);}
 else if(labor.kind==='hourly'&&labor.rate_minor!==null&&labor.minutes!==null){const n=BigInt(labor.rate_minor)*BigInt(labor.minutes);if(n%60n!==0n)throw Error('labor_fractional_minor_unit_use_fixed_price');laborValue=n/60n;}
 else if(labor.kind==='per_sku_hourly'){
  let minutes=0n,known=true;parts.forEach((p,i)=>{if(!p.catalog?.unit_label||p.catalog.installation_minutes_per_unit==null){known=false;missing.push('part_'+(i+1)+'_installation_time_or_unit');}else minutes+=BigInt(p.quantity)*BigInt(p.catalog.installation_minutes_per_unit);});
  if(known&&labor.rate_minor!==null){const n=BigInt(labor.rate_minor)*minutes;if(n%60n!==0n)throw Error('labor_fractional_minor_unit_use_fixed_price');laborValue=n/60n;}
 }
 if(laborValue===null)missing.push('labor');if(tax===null)missing.push('tax');if(fees===null)missing.push('fees');
 const sum=subtotal+(laborValue??0n)+BigInt(tax??0)+BigInt(fees??0);
 if(sum>BigInt(Number.MAX_SAFE_INTEGER))throw Error('amount_out_of_range');
 return {parts_known_minor:Number(subtotal),labor_minor:laborValue===null?null:Number(laborValue),total_minor:missing.length?null:Number(sum),missing};
}
