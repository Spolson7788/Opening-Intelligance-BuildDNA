import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {getPresignedPrivatePhotoReadUrl} from '../services/storage';
export const referencesRouter=Router();
referencesRouter.use(requireAuth,(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
const hash=z.string().regex(/^[a-f0-9]{64}$/);
referencesRouter.get('/search',async(req,res)=>{
 const parsed=z.object({q:z.string().min(1).max(200)}).safeParse(req.query);
 if(!parsed.success)return res.status(400).json({error:'invalid_reference_query'});
 try {
  const r=await pool.query(`SELECT DISTINCT d.sha256,d.brand,d.title,d.metadata FROM reference_documents d
   JOIN reference_pages p ON p.doc_sha256=d.sha256 WHERE d.status='approved' AND p.citable
   AND p.search_vector @@ plainto_tsquery('simple',$1) ORDER BY d.sha256 LIMIT 20`,[parsed.data.q]);
  return res.json({documents:r.rows});
 }catch{return res.status(503).json({error:'references_unavailable'});}
});
referencesRouter.get('/:id/pages/:n',async(req,res)=>{
 const n=Number(req.params.n);
 if(!hash.safeParse(req.params.id).success||!Number.isInteger(n)||n<1)return res.status(400).json({error:'invalid_reference_page'});
 try {
  const r=await pool.query(`SELECT p.*,d.title,d.brand,d.storage_key FROM reference_pages p JOIN reference_documents d ON d.sha256=p.doc_sha256
   WHERE d.sha256=$1 AND p.page_no=$2 AND d.status='approved' AND p.citable`,[req.params.id,n]);
  const p=r.rows[0];if(!p)return res.status(404).json({error:'reference_not_found'});
  return res.json({page:{...p,search_vector:undefined,storage_key:undefined,image_url:p.image_key?await getPresignedPrivatePhotoReadUrl(p.image_key):null,pdf_url:await getPresignedPrivatePhotoReadUrl(p.storage_key)}});
 }catch{return res.status(503).json({error:'references_unavailable'});}
});
referencesRouter.get('/:id',async(req,res)=>{
 if(!hash.safeParse(req.params.id).success)return res.status(400).json({error:'invalid_reference_id'});
 try {
  const r=await pool.query(`SELECT * FROM reference_documents WHERE sha256=$1 AND status='approved'`,[req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'reference_not_found'});
  const models=await pool.query('SELECT * FROM reference_document_models WHERE doc_sha256=$1',[req.params.id]);
  return res.json({document:r.rows[0],models:models.rows,pdf_url:await getPresignedPrivatePhotoReadUrl(r.rows[0].storage_key)});
 }catch{return res.status(503).json({error:'references_unavailable'});}
});
