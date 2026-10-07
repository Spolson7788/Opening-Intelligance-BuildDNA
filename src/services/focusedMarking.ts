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
