// Tests bundled OCR assets with synthetic text; no paid calls or real product claims.
import sharp from 'sharp';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {readLabelCropsOcr}=require('../../dist/services/labelReading.js');
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="140"><rect width="100%" height="100%" fill="white"/><text x="25" y="90" font-family="sans-serif" font-size="64" fill="black">LCN 4040XP</text></svg>');
const image=await sharp(svg).png().toBuffer();
const results=await readLabelCropsOcr([image],Date.now()+20000);
assert.match(results[0].text.toUpperCase(),/LCN\s+4040XP/);
console.log('Local OCR assets and worker: synthetic label smoke passed.');
