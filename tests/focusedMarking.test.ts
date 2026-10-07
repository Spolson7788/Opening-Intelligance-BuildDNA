import {it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {canFocusMarking,focusedMarkingViews,resolveFocusedRead} from '../src/services/focusedMarking';
import type {LabelRead} from '../src/services/labelReading';
const read=(box={x:.45,y:.45,w:.06,h:.10}):LabelRead=>({region:{photo_index:0,...box,rotation:0,kind:'brand_mark'},provenance:{source:'native_tile',target_device:true,location_validated:false,box},vision_text:'old guess',vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed'});
it('adds bounded native margin and produces exact quarter-turn views without resizing',async()=>{
 const source=await sharp(Buffer.from('<svg width="600" height="800"><rect width="600" height="800" fill="gray"/><path d="M270 360h36v80h-36z" fill="black"/></svg>')).png().toBuffer();
 const focus=await focusedMarkingViews(source,read());expect(focus.box).toEqual({left:248,top:312,width:80,height:177});
 const native=await sharp(source).extract(focus.box).png().toBuffer();
 for(const view of focus.views){const a=await sharp(view.image).raw().toBuffer(),b=await sharp(native).rotate(view.rotation).raw().toBuffer();expect(a.equals(b)).toBe(true);}
 expect(focus.views.map(v=>v.rotation)).toEqual([0,90,180,270]);
});
it('clips margins to image boundaries and never silently downscales a broad region',async()=>{
 const image=await sharp({create:{width:1800,height:1800,channels:3,background:'white'}}).png().toBuffer();
 const focus=await focusedMarkingViews(image,read({x:0,y:0,w:.05,h:.05}));expect(focus.box.left).toBe(0);expect(focus.box.top).toBe(0);
 await expect(focusedMarkingViews(image,read({x:0,y:0,w:1,h:1}))).rejects.toThrow('focused_region_too_large');
});
it('maps focused unrotated coordinates back to original pixels and rejects invalid provenance',()=>{
 const focus={box:{left:100,top:200,width:400,height:300},width:1000,height:1000};
 const r={source:'focused_crop',text_box:{x:.25,y:.2,w:.5,h:.4},rotation:270,target_device:true};
 expect(resolveFocusedRead(r,focus)).toMatchObject({source:'focused_crop',box:{x:.2,y:.26,w:.2,h:.12},rotation:270,location_validated:true});
 for(const changed of [{...r,source:'context'},{...r,rotation:45},{...r,text_box:{x:.9,y:0,w:.2,h:.2}}])expect(resolveFocusedRead(changed,focus).location_validated).toBe(false);
 expect(resolveFocusedRead({...r,target_device:false},focus).target_device).toBe(false);
});
it('never focuses background/context guesses or a marking attributed to another device',()=>{
 expect(canFocusMarking(read())).toBe(true);
 for(const p of [{source:'context',target_device:true},{source:'native_tile',target_device:false},{source:'native_tile',target_device:true,box:{x:0,y:0,w:2,h:1}}])expect(canFocusMarking({...read(),provenance:p as any})).toBe(false);
});
