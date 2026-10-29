import {Router} from 'express';
import {requireAuth,requireRole} from '../middleware/auth';

// RETIRED (Oct 29 2026): the old route accepted client-sent base64 images, kept no run record and
// had no budget guard. Recognition now runs only on stored originals through /api/recognition/runs.
// Auth is still enforced so the retirement notice is not an anonymous probe; nothing is read or called.
export const RECOGNITION_ROUTE_RETIRED={error:'recognition_route_retired',use:'/api/recognition/runs'} as const;
export const recognitionRouter=Router();
recognitionRouter.use(requireAuth,requireRole('admin','technician','inspector','facilities_manager'));
recognitionRouter.post('/',(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Link','</api/recognition/runs>; rel="successor-version"');
  return res.status(410).json(RECOGNITION_ROUTE_RETIRED);
});
