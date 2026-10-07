import sharp from 'sharp';
import {recognitionInputPixelLimit} from './recognitionOriginalLimits';
import type {ReadProvenance} from './labelReading';
export interface NativeTile {index:number;box:{left:number;top:number;width:number;height:number};image:Buffer}
// Cover every native pixel, independent of locator coordinates and expected text.
// Materialize each tile before conversion so provider resizing cannot erase a
// small sticker in the full frame. The grid has a bounded 20-image maximum.
export async function nativeLabelTiles(image:Buffer):Promise<{width:number;height:number;tiles:NativeTile[]}>{
 const m=await sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).metadata();
 if(!m.width||!m.height)throw Error('invalid_image');
 const cols=Math.ceil(m.width/1400),rows=Math.ceil(m.height/1400);
 if(cols*rows>20)throw Error('native_tile_limit');
 const tiles:NativeTile[]=[];
 for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
  const left=Math.max(0,x*1400-80),top=Math.max(0,y*1400-80);
  const box={left,top,width:Math.min(1560,m.width-left),height:Math.min(1560,m.height-top)};
  const buffer=await sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).extract(box).png().toBuffer();
  tiles.push({index:tiles.length,box,image:buffer});
 }
 return {width:m.width,height:m.height,tiles};
}
export function resolveNativeRead(value:any,tiles:NativeTile[],width:number,height:number):ReadProvenance {
 const tile=tiles.find(t=>t.index===value?.tile_index),b=value?.text_box;
 const valid=tile&&b&&['x','y','w','h'].every(k=>typeof b[k]==='number'&&Number.isFinite(b[k]))&&b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=1&&b.y+b.h<=1;
 if(!valid||value.source!=='native_tile')return {source:'context',target_device:false,location_validated:false};
 return {source:'native_tile',target_device:value.target_device===true,location_validated:true,
  box:{x:(tile.box.left+b.x*tile.box.width)/width,y:(tile.box.top+b.y*tile.box.height)/height,w:b.w*tile.box.width/width,h:b.h*tile.box.height/height},rotation:[0,90,180,270].includes(value.rotation)?value.rotation:0};
}
