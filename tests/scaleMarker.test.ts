import {it,expect} from 'vitest';
import sharp from 'sharp';
import QRCode from 'qrcode';
import {readFileSync} from 'node:fs';
import {detectScaleMarkers,markerPlaneTransform,scaleMeasurements,SCALE_PAYLOAD,type ScaleMarker} from '../src/services/scaleMarker';
it('detects the actual printable marker at its 40 mm code boundary and ignores unrelated QR data',async()=>{
 const svg=readFileSync('field-app/public/scale-marker.svg');
 const image=await sharp(svg,{density:150}).png().toBuffer();
 const found=await detectScaleMarkers([image]);expect(found).toHaveLength(1);expect(found[0].size_mm).toBe(40);
 expect(found[0].corners[1].x-found[0].corners[0].x).toBeCloseTo(.5,1);
 expect(await detectScaleMarkers([await QRCode.toBuffer('unrelated opening QR',{width:400})])).toEqual([]);
 expect(SCALE_PAYLOAD).toBe('OI_SCALE_V1_40MM');
});
it('recovers known distances under perspective and requires explicit placement confirmation',()=>{
 const map=(x:number,y:number)=>({x:(.004*x+.1)/(1+.003*x+.001*y),y:(.005*y+.15)/(1+.003*x+.001*y)});
 const corners=[map(0,0),map(40,0),map(40,40),map(0,40)];
 const marker:ScaleMarker={photo_index:0,size_mm:40,corners,status:'detected',print_size_verified:false};
 const transform=markerPlaneTransform(corners)!;const end=transform(map(100,20));expect(end.x).toBeCloseTo(100,5);expect(end.y).toBeCloseTo(20,5);
 const segments=[{photo_index:0,feature:'closer_body_length',points:[map(0,20),map(100,20)]}];
 expect(scaleMeasurements(segments,[marker],false)).toEqual([]);
 expect(scaleMeasurements(segments,[marker],true)[0].estimate_mm).toBe(100);
 expect(scaleMeasurements([{...segments[0],photo_index:1}],[marker],true)).toEqual([]);
});
it('rejects degenerate geometry, invented features and invalid endpoint coordinates',()=>{
 expect(markerPlaneTransform([{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}])).toBeNull();
 const marker:ScaleMarker={photo_index:0,size_mm:40,corners:[{x:.1,y:.1},{x:.3,y:.1},{x:.3,y:.3},{x:.1,y:.3}],status:'detected',print_size_verified:false};
 expect(scaleMeasurements([{feature:'guessed_inches',photo_index:0,points:[{x:0,y:0},{x:.5,y:.5}]}],[marker],true)).toEqual([]);
 expect(scaleMeasurements([{feature:'closer_body_length',photo_index:0,points:[{x:-1,y:0},{x:.5,y:.5}]}],[marker],true)).toEqual([]);
});

it('finds a calibration marker when an unrelated opening QR is also in the photo',async()=>{
 const unrelated=await QRCode.toBuffer('opening-record-123',{width:240});
 const marker=await QRCode.toBuffer(SCALE_PAYLOAD,{width:240,errorCorrectionLevel:'H'});
 const photo=await sharp({create:{width:520,height:260,channels:4,background:'white'}}).composite([{input:unrelated,left:10,top:10},{input:marker,left:270,top:10}]).png().toBuffer();
 expect(await detectScaleMarkers([photo])).toHaveLength(1);
});
