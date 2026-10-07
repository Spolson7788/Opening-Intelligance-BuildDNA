import sharp from 'sharp';
import {recognitionInputPixelLimit} from './recognitionOriginalLimits';
import type {LabelRead,ReadProvenance} from './labelReading';
export function canFocusMarking(read:LabelRead){
 const p=read.provenance,b=p?.box;
 return p?.source==='native_tile'&&p.target_device===true&&!!b&&[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=1&&b.y+b.h<=1;
}
export async function focusedMarkingViews(image:Buffer,read:LabelRead){
 if(!canFocusMarking(read))throw Error('focused_location_missing');
 const m=await sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).metadata();if(!m.width||!m.height)throw Error('invalid_image');
 let b=read.provenance!.box!;
 const locator=read.locator_region;
 // A blank maker proposal outside the locator's mark cannot be the sole
 // verification target. Revisit the original marking region, without using
 // the guessed brand or any product-specific coordinates.
 const coarse=read.region.kind==='brand_mark'&&read.provenance!.location_validated===false&&locator&&locator.kind==='brand_mark'&&locator.photo_index===read.region.photo_index&&[locator.x,locator.y,locator.w,locator.h].every(Number.isFinite)&&locator.x>=0&&locator.y>=0&&locator.w>0&&locator.h>0&&locator.x+locator.w<=1&&locator.y+locator.h<=1&&(b.x>=locator.x+locator.w||locator.x>=b.x+b.w||b.y>=locator.y+locator.h||locator.y>=b.y+b.h);
 if(coarse)b=locator;
 // A location proposal may clip letters. Add equal native-pixel margin without
 // depending on a brand, model, photograph number, expected text or rotation.
 const margin=coarse?.1:.6;
 const padX=Math.max(16,Math.ceil(b.w*m.width*margin)),padY=Math.max(16,Math.ceil(b.h*m.height*margin));
 const left=Math.max(0,Math.floor(b.x*m.width)-padX),top=Math.max(0,Math.floor(b.y*m.height)-padY);
 const right=Math.min(m.width,Math.ceil((b.x+b.w)*m.width)+padX),bottom=Math.min(m.height,Math.ceil((b.y+b.h)*m.height)+padY);
 const box={left,top,width:right-left,height:bottom-top};
 if(Math.max(box.width,box.height)>1568)throw Error('focused_region_too_large');
 const native=await sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).extract(box).png().toBuffer();
 const views=await Promise.all([0,90,180,270].map(async rotation=>({rotation,image:await sharp(native).rotate(rotation).png().toBuffer()})));
 return {box,width:m.width,height:m.height,views};
}
export function resolveFocusedRead(value:any,focus:{box:{left:number;top:number;width:number;height:number};width:number;height:number}):ReadProvenance{
 const b=value?.text_box;
 if(value?.source!=='focused_crop'||!b||![b.x,b.y,b.w,b.h].every(v=>typeof v==='number'&&Number.isFinite(v))||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>1||b.y+b.h>1||![0,90,180,270].includes(value.rotation))return {source:'context',target_device:false,location_validated:false};
 const original=value.rotation===90?{x:b.y,y:1-b.x-b.w,w:b.h,h:b.w}:value.rotation===180?{x:1-b.x-b.w,y:1-b.y-b.h,w:b.w,h:b.h}:value.rotation===270?{x:1-b.y-b.h,y:b.x,w:b.h,h:b.w}:b;
 return {source:'focused_crop',target_device:value.target_device===true,...(typeof value.target_device!=='boolean'?{association_status:'invalid' as const}:{}),location_validated:true,box:{x:(focus.box.left+original.x*focus.box.width)/focus.width,y:(focus.box.top+original.y*focus.box.height)/focus.height,w:original.w*focus.box.width/focus.width,h:original.h*focus.box.height/focus.height},rotation:value.rotation};
}

// A transcription can cite the exact supplied view without asking the model
// to draw a second rectangle. The source bounds are entirely server-derived.
export function resolveFocusedViewRead(value:any,focus:Awaited<ReturnType<typeof focusedMarkingViews>>):ReadProvenance{
 const view=focus.views.find((_,index)=>index===value?.view_index);
 if(value?.source!=='focused_view'||!Number.isInteger(value.view_index)||!view)return {source:'context',target_device:false,location_validated:false};
 const complete=value.all_characters_visible===true&&value.legibility==='clear'&&typeof value.text==='string'&&value.text.trim().length>0&&!value.text.includes('?');
 return {source:'focused_view',target_device:value.target_device===true,...(typeof value.target_device!=='boolean'?{association_status:'invalid' as const}:{}),
  location_validated:complete,verification_scope:'supplied_view',marking_complete:complete,view_index:value.view_index,
  box:{x:focus.box.left/focus.width,y:focus.box.top/focus.height,w:focus.box.width/focus.width,h:focus.box.height/focus.height},rotation:view.rotation};
}

// Cast letters can have soft gradients at native resolution. Normalize only
// this inexpensive structure diagnostic; provider views keep native pixels.
// This detects spatial structure, not letters, identity or semantic truth.
export async function markingStructurePresent(image:Buffer){
 const {data,info}=await sharp(image).greyscale().resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).normalise().raw().toBuffer({resolveWithObject:true});
 // A complete logo can occupy a small part of the bounded hardware view.
 // Check spatial windows as well as the frame; a featureless frame still fails.
 const windows=[{left:0,top:0,width:info.width,height:info.height}];
 for(let y=0;y<2;y++)for(let x=0;x<2;x++){
  const left=Math.floor(x*info.width/2),top=Math.floor(y*info.height/2);
  windows.push({left,top,width:Math.floor((x+1)*info.width/2)-left,height:Math.floor((y+1)*info.height/2)-top});
 }
 return windows.some(w=>{
  let edges=0,total=0,rows=0,columns=0;
  for(let y=w.top;y<w.top+w.height;y++){let n=0;for(let x=w.left+1;x<w.left+w.width;x++){total++;if(Math.abs(data[y*info.width+x]-data[y*info.width+x-1])>=16){edges++;n++;}}if(n>=6)rows++;}
  for(let x=w.left;x<w.left+w.width;x++){let n=0;for(let y=w.top+1;y<w.top+w.height;y++){total++;if(Math.abs(data[y*info.width+x]-data[(y-1)*info.width+x])>=16){edges++;n++;}}if(n>=6)columns++;}
  return total>0&&edges/total>=.01&&(rows>=Math.max(2,w.height*.15)||columns>=Math.max(2,w.width*.15));
 });
}
