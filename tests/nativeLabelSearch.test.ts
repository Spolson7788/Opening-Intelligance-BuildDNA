import {it,expect} from 'vitest';
import sharp from 'sharp';
import {nativeLabelTiles,resolveNativeRead} from '../src/services/nativeLabelSearch';
it('covers native pixels at tile boundaries without resizing the source',async()=>{
 const image=await sharp({create:{width:2900,height:1500,channels:3,background:'white'}}).png().toBuffer();
 const native=await nativeLabelTiles(image);
 expect(native.tiles).toHaveLength(6);
 for(const tile of native.tiles){const m=await sharp(tile.image).metadata();expect(m.width).toBe(tile.box.width);expect(m.height).toBe(tile.box.height);}
 expect(native.tiles.some(t=>t.box.left+t.box.width===2900)).toBe(true);
 const p=resolveNativeRead({source:'native_tile',tile_index:5,text_box:{x:.1,y:.2,w:.2,h:.3},target_device:true,rotation:270},native.tiles,native.width,native.height);
 expect(p.location_validated).toBe(true);expect(p.rotation).toBe(270);expect(p.box!.x).toBeGreaterThan(.9);
});
it('rejects unlocated context, invalid boxes, and missing target association',()=>{
 const tiles=[{index:0,box:{left:0,top:0,width:100,height:100},image:Buffer.alloc(0)}];
 expect(resolveNativeRead({source:'context',text_box:{x:0,y:0,w:1,h:1}},tiles,100,100).location_validated).toBe(false);
 expect(resolveNativeRead({source:'native_tile',tile_index:0,text_box:{x:.8,y:0,w:.5,h:1}},tiles,100,100).location_validated).toBe(false);
 expect(resolveNativeRead({source:'native_tile',tile_index:0,text_box:{x:0,y:0,w:1,h:1}},tiles,100,100).target_device).toBe(false);
});
