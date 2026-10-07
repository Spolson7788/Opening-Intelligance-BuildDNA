import {markerPlaneTransform,Point} from './scaleMarker';
import {pool} from '../db/pool';

// Numerical facts visually checked against the original, hash-matched drawings.
// These dimensions describe installation holes, not the outside of the casting.
export const INSTALLATION_GEOMETRY_VERSION='oi-installation-geometry-3';
import geometryCatalog from '../data/installationGeometryCatalog.json';
export const geometrySources=geometryCatalog;

export const GEOMETRY_OBSERVATION_PROMPT=`For a DOOR_CLOSER also return installation_geometry_views:[{photo_index,mount:"pull_side|other|unknown",coplanar:true,face_corners:[{x,y},{x,y},{x,y},{x,y}],mounting_holes:[{x,y},{x,y},{x,y},{x,y}]}]. Use normalized coordinates in the ORIGINAL photograph. Return a view only if four actual body mounting screw/hole centers AND four corners of a genuinely rectangular flat mounting face are all directly visible in that SAME plane. Order corners top-left, top-right, bottom-right, bottom-left, with the long body direction horizontal after rectification. Do not use cover screws, arm shoe holes, valves or the spindle as mounting holes. Do not use the curved casting silhouette as rectangular face corners. Do not mix the projecting front of the body with its mounting face or the door plane. Omit obscured landmarks; do not reconstruct hidden holes or use catalog dimensions to invent them. If no such face is visible return an empty array. This is landmark observation only; do not name a model or report dimensions from geometry.`;

function point(v:any):v is Point{return !!v&&Number.isFinite(v.x)&&Number.isFinite(v.y)&&v.x>=0&&v.x<=1&&v.y>=0&&v.y<=1;}
export function compareInstallationGeometry(value:unknown,photoCount:number,sources=geometrySources){
 const malformed=!Array.isArray(value)||value.some(v=>!v||!Number.isInteger(v.photo_index)||v.photo_index<0||v.photo_index>=photoCount||!['pull_side','other','unknown'].includes(v.mount)||typeof v.coplanar!=='boolean'||!Array.isArray(v.face_corners)||v.face_corners.length!==4||!v.face_corners.every(point)||!Array.isArray(v.mounting_holes)||v.mounting_holes.length!==4||!v.mounting_holes.every(point));
 const matchedSources=new Set<(typeof sources)[number]>();
 const observations:{photo_index:number;relative_intervals:number[];max_relative_error:number;layout_compatible:boolean}[]=[];
 for(const v of Array.isArray(value)?value.slice(0,5):[]){
  if(!v||!Number.isInteger(v.photo_index)||v.photo_index<0||v.photo_index>=photoCount||v.mount!=='pull_side'||v.coplanar!==true||!Array.isArray(v.face_corners)||v.face_corners.length!==4||!v.face_corners.every(point)||!Array.isArray(v.mounting_holes)||v.mounting_holes.length!==4||!v.mounting_holes.every(point))continue;
  // Independent rectangular face rectifies perspective. Four holes alone can
  // fit any projective quadrilateral and therefore cannot validate this pattern.
  const transform=markerPlaneTransform(v.face_corners);if(!transform)continue;
  const holes=v.mounting_holes.map(transform).map((p:Point)=>({x:p.x/40,y:p.y/40})).sort((a:Point,b:Point)=>a.x-b.x);
  if(holes.some((p:Point)=>!point(p)))continue;
  const dx=[holes[1].x-holes[0].x,holes[2].x-holes[1].x,holes[3].x-holes[2].x];
  const unit=(dx[0]+dx[2])/2;if(unit<.02||dx[1]<=0)continue;
  // Two pairs in distinct rows; missing or different-plane landmarks abstain.
  const rowGap=Math.abs((holes[0].y+holes[1].y-holes[2].y-holes[3].y)/2);
  if(rowGap<.04)continue;
  const rowError=Math.max(Math.abs(holes[0].y-holes[1].y),Math.abs(holes[2].y-holes[3].y))/rowGap;
  const relative=dx.map((d:number)=>d/unit);
  const errors=sources.map(source=>{
   const intervals=source.horizontal_intervals_inches;
   if(intervals.length!==3||!intervals.every(n=>Number.isFinite(n)&&n>0))return Infinity;
   const sourceUnit=(intervals[0]+intervals[2])/2;
   const error=Math.max(rowError,...relative.map((d:number,i:number)=>Math.abs(d-intervals[i]/sourceUnit)/(intervals[i]/sourceUnit)));
   if(error<=.2)matchedSources.add(source);
   return error;
  });
  const error=Math.min(...errors);
  observations.push({photo_index:v.photo_index,relative_intervals:relative.map((d:number)=>Number(d.toFixed(3))),max_relative_error:Number(error.toFixed(3)),layout_compatible:error<=.2});
 }
 const compatible=observations.some(o=>o.layout_compatible);
 return {version:INSTALLATION_GEOMETRY_VERSION,status:malformed?'invalid_geometry_input':compatible?'shared_pattern_compatible':observations.length?'pattern_not_supported':'insufficient_visible_landmarks',observations,
  candidates:compatible&&!malformed?[...matchedSources].flatMap(s=>s.models.map(model=>({manufacturer:s.manufacturer,model,basis:'shared_mounting_pattern',source:s}))):[],
  absolute_photo_dimensions:null,identity_verified:false,
  limitation:malformed?'Geometry analysis received invalid landmark data. No dimensional conclusion was made about the photograph.':compatible?'This shared pattern cannot distinguish these models. Verify markings, valve configuration and arm features.':observations.length?'The visible layout did not support the pilot pattern. Other mounting arrangements and products remain possible.':'Perspective correction could not be established from the detected landmarks. This does not mean the mounting holes are hidden. No dimension match was computed; see the label, arm and reference results separately.',
  reference_dimensions:sources,
 };
}

export async function approvedInstallationGeometry(value:unknown,photoCount:number){
 const rows=(await pool.query(`SELECT d.sha256,p.page_no,m.model FROM reference_documents d
  JOIN reference_pages p ON p.doc_sha256=d.sha256
  JOIN reference_document_models m ON m.doc_sha256=d.sha256 AND m.evidence_page=p.page_no
  WHERE d.status='approved' AND p.citable AND NOT p.fraction_unverified
  AND d.sha256=ANY($1::text[])`,[geometrySources.map(s=>s.doc_sha256)])).rows;
 const sources=geometrySources.map(s=>({...s,models:s.models.filter(model=>rows.some(r=>r.sha256===s.doc_sha256&&r.page_no===s.page_no&&r.model===model))})).filter(s=>s.models.length);
 const result=compareInstallationGeometry(value,photoCount,sources);
 if(!sources.length)return {...result,status:'reference_geometry_unavailable',candidates:[],limitation:'Approved installation geometry is unavailable. Photograph recognition continues.'};
 return result;
}
