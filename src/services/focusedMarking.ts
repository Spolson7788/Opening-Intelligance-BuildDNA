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
 const b=read.provenance!.box!;
 // A location proposal may clip letters. Add equal native-pixel margin without
 // depending on a brand, model, photograph number, expected text or rotation.
 const padX=Math.max(16,Math.ceil(b.w*m.width*.6)),padY=Math.max(16,Math.ceil(b.h*m.height*.6));
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
 return {source:'focused_crop',target_device:value.target_device===true,location_validated:true,box:{x:(focus.box.left+b.x*focus.box.width)/focus.width,y:(focus.box.top+b.y*focus.box.height)/focus.height,w:b.w*focus.box.width/focus.width,h:b.h*focus.box.height/focus.height},rotation:value.rotation};
}
