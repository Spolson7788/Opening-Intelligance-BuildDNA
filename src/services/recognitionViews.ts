import {recognitionInputPixelLimit} from './recognitionOriginalLimits';
import sharp from 'sharp';
export interface DetailView {photo_index:number;region:{x:number;y:number;w:number;h:number};image:Buffer}
// Supply overlapping detail views as well as the whole opening. These are not
// detected objects, new photographs, or evidence of extra pixels.
export async function recognitionDetailViews(images:Buffer[]):Promise<DetailView[]>{
 const views:DetailView[]=[];
 for(let i=0;i<Math.min(images.length,3);i++){
  try{
   const m=await sharp(images[i],{limitInputPixels:recognitionInputPixelLimit()}).metadata();
   if(!m.width||!m.height)continue;
   for(const y of [0,.35]){
    const top=Math.floor(m.height*y),height=Math.min(m.height-top,Math.ceil(m.height*.65));
    const image=await sharp(images[i],{limitInputPixels:recognitionInputPixelLimit()}).extract({left:0,top,width:m.width,height}).resize({width:Math.min(1400,m.width*3),height:Math.min(1400,height*3),fit:'inside'}).png().toBuffer();
    views.push({photo_index:i,region:{x:0,y:top/m.height,w:1,h:height/m.height},image});
   }
  }catch{/* Original photograph remains available if a detail view fails. */}
 }
 return views;
}
