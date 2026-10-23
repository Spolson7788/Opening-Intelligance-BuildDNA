import {z} from 'zod';

// Calendar facts retain exactly the precision entered; no synthetic day/month.
export const installationDateSchema=z.object({
  certainty:z.enum(['confirmed','estimated','unknown']),
  precision:z.enum(['day','month','year','unknown']),
  year:z.number().int().min(1).max(9999).nullable(),
  month:z.number().int().min(1).max(12).nullable(),
  day:z.number().int().min(1).max(31).nullable(),
}).strict().superRefine((d,ctx)=>{
  const unknown=d.certainty==='unknown';
  let valid=unknown?d.precision==='unknown'&&d.year===null&&d.month===null&&d.day===null:
    d.precision!=='unknown'&&d.year!==null&&
    (d.precision==='year'?d.month===null&&d.day===null:
     d.month!==null&&(d.precision==='month'?d.day===null:d.day!==null));
  if(valid&&d.precision==='day'){
    const leap=d.year!%4===0&&(d.year!%100!==0||d.year!%400===0);
    const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    valid=d.day!<=days[d.month!-1];
  }
  if(!valid)ctx.addIssue({code:'custom',message:'Date parts must match certainty and calendar precision.'});
});
export const installationFactSchema=z.object({
  target:z.object({type:z.enum(['opening','frame','door_leaf','component']),id:z.string().uuid()}).strict(),
  date:installationDateSchema,
  source_type:z.enum(['installation_record','maintenance_log','invoice','provider','recollection','unknown']),
  source_reference:z.string().trim().max(1000),
  note:z.string().trim().max(4000),
  correction_of:z.string().uuid().nullable(),
  correction_reason:z.string().trim().max(2000),
}).strict().superRefine((p,ctx)=>{
  if(p.date.certainty==='confirmed'&&(p.source_type==='unknown'||p.source_type==='recollection'||!p.source_reference))
    ctx.addIssue({code:'custom',message:'Confirmed installation requires an identified evidence source.'});
  if(p.correction_of&&!p.correction_reason)ctx.addIssue({code:'custom',message:'Correction reason required.'});
  if(!p.correction_of&&p.correction_reason)ctx.addIssue({code:'custom',message:'Correction reason requires a previous fact.'});
});
