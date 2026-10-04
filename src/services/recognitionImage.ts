import sharp from 'sharp';
// Coordinates downstream refer to this upright, opaque image, never EXIF storage axes.
export async function normalizeRecognitionImage(image:Buffer){
 return sharp(image,{limitInputPixels:16_000_000}).rotate().removeAlpha().png().toBuffer();
}
