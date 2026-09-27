import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,requireRole,AuthedRequest} from '../middleware/auth';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {legacyVisionHandler} from '../services/legacyVision';

const schema=z.object({
  opening_id:z.string().uuid(),
  images:z.array(z.string().min(4).max(2800000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)).min(1).max(5),
  media_type:z.enum(['image/jpeg','image/png','image/webp']),
  mode:z.enum(['identify','label_blind','marking_regions','hardware_regions']).default('identify'),
  focus_features:z.array(z.string().min(1).max(120)).max(20).optional(),
}).strict();
export const recognitionRouter=Router();
recognitionRouter.use(requireAuth,requireRole('admin','technician','inspector','facilities_manager'));
recognitionRouter.post('/',async(req:AuthedRequest,res)=>{
  res.setHeader('Cache-Control','no-store');
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'invalid_recognition_request'});
  const b=parsed.data;
  const images=b.images.map(s=>Buffer.from(s,'base64'));
  if(images.reduce((n,x)=>n+x.length,0)>2*1024*1024)return res.status(413).json({error:'recognition_images_too_large'});
  const valid=images.every(x=>b.media_type==='image/jpeg'?x[0]===255&&x[1]===216&&x[2]===255:
    b.media_type==='image/png'?x.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    x.subarray(0,4).toString()==='RIFF'&&x.subarray(8,12).toString()==='WEBP');
  if(!valid)return res.status(400).json({error:'image_type_mismatch'});
  try{
    const allowed=await pool.query(`SELECT 1 FROM (${openingsForOrgSubquery(2)}) a WHERE a.id=$1`,[b.opening_id,req.auth!.organizationId]);
    if(!allowed.rows.length)return res.status(404).json({error:'opening_not_found'});
    // Explicit release switch prevents unintended paid calls during preview tests.
    if(process.env.OI_RECOGNITION_ENABLED!=='true'||!process.env.ANTHROPIC_API_KEY)return res.status(503).json({error:'recognition_unavailable'});
    const response=await legacyVisionHandler({httpMethod:'POST',body:JSON.stringify(b)});
    if(response.statusCode!==200)return res.status(502).json({error:'recognition_provider_failed'});
    const result=JSON.parse(response.body);
    if(!result||typeof result!=='object'||Array.isArray(result))return res.status(502).json({error:'recognition_provider_failed'});
    // A suggestion is not a reviewed identity or purchasing approval.
    return res.json({suggestion:result,requires_technician_review:true});
  }catch{return res.status(503).json({error:'recognition_unavailable'});}
});
