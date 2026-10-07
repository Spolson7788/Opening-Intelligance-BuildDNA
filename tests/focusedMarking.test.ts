import {it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {canFocusMarking,focusedMarkingViews,resolveFocusedRead,resolveFocusedViewRead,markingStructurePresent} from '../src/services/focusedMarking';
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
it('maps focused rotated-view coordinates back to original pixels and rejects invalid provenance',()=>{
 const focus={box:{left:100,top:200,width:400,height:300},width:1000,height:1000};
 const r={source:'focused_crop',text_box:{x:.25,y:.2,w:.5,h:.4},rotation:270,target_device:true};
 expect(resolveFocusedRead(r,focus)).toMatchObject({source:'focused_crop',box:{x:.26,y:.275,w:.16,h:.15},rotation:270,location_validated:true});
 for(const changed of [{...r,source:'context'},{...r,rotation:45},{...r,text_box:{x:.9,y:0,w:.2,h:.2}}])expect(resolveFocusedRead(changed,focus).location_validated).toBe(false);
 expect(resolveFocusedRead({...r,target_device:false},focus).target_device).toBe(false);
});
it('never focuses background/context guesses or a marking attributed to another device',()=>{
 expect(canFocusMarking(read())).toBe(true);
 for(const p of [{source:'context',target_device:true},{source:'native_tile',target_device:false},{source:'native_tile',target_device:true,box:{x:0,y:0,w:2,h:1}}])expect(canFocusMarking({...read(),provenance:p as any})).toBe(false);
});

it('maps the same marking from all four rotated views to one original box',()=>{
 const focus={box:{left:100,top:200,width:400,height:300},width:1000,height:1000};
 const views=[{rotation:0,text_box:{x:.2,y:.3,w:.4,h:.1}},{rotation:90,text_box:{x:.6,y:.2,w:.1,h:.4}},{rotation:180,text_box:{x:.4,y:.6,w:.4,h:.1}},{rotation:270,text_box:{x:.3,y:.4,w:.1,h:.4}}];
 for(const view of views){const p=resolveFocusedRead({...view,source:'focused_crop',target_device:true},focus);expect(p.box!.x).toBeCloseTo(.18);expect(p.box!.y).toBeCloseTo(.29);expect(p.box!.w).toBeCloseTo(.16);expect(p.box!.h).toBeCloseTo(.03);}
});

it('revisits the locator maker region when a blank reader proposal lies elsewhere',async()=>{
 const image=await sharp({create:{width:1000,height:1200,channels:3,background:'white'}}).png().toBuffer();
 const read:any={region:{photo_index:0,kind:'brand_mark'},locator_region:{photo_index:0,kind:'brand_mark',x:.3,y:.4,w:.25,h:.18},provenance:{source:'native_tile',target_device:true,location_validated:false,box:{x:.75,y:.43,w:.06,h:.13}}};
 const focus=await focusedMarkingViews(image,read);
 expect(focus.box.left).toBeLessThanOrEqual(300);expect(focus.box.left+focus.box.width).toBeGreaterThanOrEqual(550);
 expect(focus.box.left+focus.box.width).toBeLessThan(750);
 read.provenance.location_validated=true;
 const validated=await focusedMarkingViews(image,read);expect(validated.box.left).toBeGreaterThan(550);
});

it('references exact supplied-view bounds regardless of an AI letter rectangle',async()=>{
 const image=await sharp({create:{width:400,height:500,channels:3,background:'white'}}).png().toBuffer();
 const focus=await focusedMarkingViews(image,read());
 const value={source:'focused_view',view_index:1,text:'ABC',legibility:'clear',all_characters_visible:true,target_device:true,text_box:{x:.9,y:.9,w:.01,h:.01}};
 const p=resolveFocusedViewRead(value,focus);
 expect(p).toMatchObject({source:'focused_view',verification_scope:'supplied_view',view_index:1,rotation:90,location_validated:true});
 expect(p.box).toEqual({x:focus.box.left/400,y:focus.box.top/500,w:focus.box.width/400,h:focus.box.height/500});
 for(const changed of [{view_index:4},{view_index:'1'},{source:'focused_crop'},{all_characters_visible:false},{all_characters_visible:'true'},{legibility:'partial'},{text:'AB?'},{text:''}])expect(resolveFocusedViewRead({...value,...changed},focus).location_validated).toBe(false);
 const invalid=resolveFocusedViewRead({...value,target_device:'exit device'},focus);expect(invalid.target_device).toBe(false);expect(invalid.association_status).toBe('invalid');
 expect(resolveFocusedViewRead({...value,target_device:false},focus).target_device).toBe(false);
});
it('checks marking structure at consistent scale without turning blank metal into identity evidence',async()=>{
 const flat=await sharp({create:{width:1200,height:1300,channels:3,background:'#888'}}).png().toBuffer();
 expect(await markingStructurePresent(flat)).toBe(false);
 const letters=await sharp(Buffer.from('<svg width="600" height="800"><rect width="600" height="800" fill="#999"/><text x="90" y="400" font-size="130" fill="#777">ABC</text></svg>')).png().toBuffer();
 const large=await sharp(letters).resize(1200,1600).png().toBuffer();
 expect(await markingStructurePresent(letters)).toBe(true);expect(await markingStructurePresent(large)).toBe(true);
});
