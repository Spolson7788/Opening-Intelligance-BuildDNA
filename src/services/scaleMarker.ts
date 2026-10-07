import {recognitionInputPixelLimit} from './recognitionOriginalLimits';
import sharp from 'sharp';
import jsQR from 'jsqr';
export const SCALE_PAYLOAD='OI_SCALE_V1_40MM';
export type Point={x:number;y:number};
export interface ScaleMarker {photo_index:number;size_mm:40;corners:Point[];status:'detected';print_size_verified:false}
export async function detectScaleMarkers(images:Buffer[]):Promise<ScaleMarker[]>{
 const markers:ScaleMarker[]=[];
 for(let photo_index=0;photo_index<Math.min(3,images.length);photo_index++){
  try{
   const {data,info}=await sharp(images[photo_index],{limitInputPixels:recognitionInputPixelLimit()}).resize({width:1200,height:1200,fit:'inside',withoutEnlargement:true}).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
   const pixels=new Uint8ClampedArray(data);
   let qr:ReturnType<typeof jsQR>=null;
   for(let attempt=0;attempt<3;attempt++){
    const decoded=jsQR(pixels,info.width,info.height,{inversionAttempts:'dontInvert'});
    if(!decoded)break;
    if(decoded.data===SCALE_PAYLOAD){qr=decoded;break;}
    // An opening QR must not hide a neighbouring calibration marker.
    const c=[decoded.location.topLeftCorner,decoded.location.topRightCorner,decoded.location.bottomRightCorner,decoded.location.bottomLeftCorner];
    const left=Math.max(0,Math.floor(Math.min(...c.map(p=>p.x)))-4),right=Math.min(info.width,Math.ceil(Math.max(...c.map(p=>p.x)))+4);
    const top=Math.max(0,Math.floor(Math.min(...c.map(p=>p.y)))-4),bottom=Math.min(info.height,Math.ceil(Math.max(...c.map(p=>p.y)))+4);
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)pixels.fill(255,(y*info.width+x)*4,(y*info.width+x)*4+4);
   }
   if(!qr)continue;
   const points=[qr.location.topLeftCorner,qr.location.topRightCorner,qr.location.bottomRightCorner,qr.location.bottomLeftCorner];
   const sides=points.map((p,i)=>Math.hypot(p.x-points[(i+1)%4].x,p.y-points[(i+1)%4].y));
   if(Math.min(...sides)<60)continue; // Insufficient marker pixels for calibration.
   markers.push({photo_index,size_mm:40,corners:points.map(p=>({x:p.x/info.width,y:p.y/info.height})),status:'detected',print_size_verified:false});
  }catch{/* A missing marker must never prevent photograph recognition. */}
 }
 return markers;
}
export function markerPlaneTransform(corners:Point[]):((p:Point)=>Point)|null{
 if(corners.length!==4||corners.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>1||p.y>1))return null;
 const cross=corners.map((p,i)=>{const q=corners[(i+1)%4],r=corners[(i+2)%4];return (q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x);});
 if(cross.some(v=>Math.abs(v)<1e-8)||!cross.every(v=>Math.sign(v)===Math.sign(cross[0])))return null;
 const target=[{x:0,y:0},{x:40,y:0},{x:40,y:40},{x:0,y:40}];const a:number[][]=[];
 corners.forEach((p,i)=>{const q=target[i];a.push([p.x,p.y,1,0,0,0,-q.x*p.x,-q.x*p.y,q.x],[0,0,0,p.x,p.y,1,-q.y*p.x,-q.y*p.y,q.y]);});
 for(let i=0;i<8;i++){
  let pivot=i;for(let j=i+1;j<8;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;
  if(Math.abs(a[pivot][i])<1e-10)return null;
  [a[pivot],a[i]]=[a[i],a[pivot]];const v=a[i][i];a[i]=a[i].map(x=>x/v);
  for(let j=0;j<8;j++)if(j!==i){const f=a[j][i];a[j]=a[j].map((x,k)=>x-f*a[i][k]);}
 }
 const h=a.map(r=>r[8]);return p=>{const d=h[6]*p.x+h[7]*p.y+1;return {x:(h[0]*p.x+h[1]*p.y+h[2])/d,y:(h[3]*p.x+h[4]*p.y+h[5])/d};};
}
export function scaleMeasurements(value:unknown,markers:ScaleMarker[],placementConfirmed:boolean){
 if(!placementConfirmed)return [];
 const out:{feature:string;photo_index:number;estimate_mm:number;basis:'marker_plane_estimate';points:Point[]}[]=[];
 for(const s of Array.isArray(value)?value.slice(0,8):[]){
  if(!s||!['closer_body_length','closer_body_height','mounting_hole_spacing'].includes(s.feature)||!Number.isInteger(s.photo_index)||!Array.isArray(s.points)||s.points.length!==2)continue;
  if(s.points.some((p:any)=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>1||p.y>1))continue;
  const marker=markers.find(m=>m.photo_index===s.photo_index);if(!marker)continue;
  const transform=markerPlaneTransform(marker.corners);if(!transform)continue;
  const [p,q]=s.points.map(transform);const distance=Math.hypot(p.x-q.x,p.y-q.y);
  if(!Number.isFinite(distance)||distance<3||distance>1000)continue;
  out.push({feature:s.feature,photo_index:s.photo_index,estimate_mm:Math.round(distance),basis:'marker_plane_estimate',points:s.points.map((p:Point)=>({x:p.x,y:p.y}))});
 }
 return out;
}
