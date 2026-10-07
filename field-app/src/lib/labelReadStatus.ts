export function labelConfirmationMessage(reads:any[]){
 if(reads.some(r=>r.ocr_model_conflicts?.length))return 'OCR returned conflicting model characters; verify before using.';
 if(reads.some(r=>r.ocr_status==='timeout'))return 'OCR timed out before confirmation; verify the AI reading before using.';
 if(reads.some(r=>r.ocr_status==='unavailable'))return 'OCR could not run; verify the AI reading before using.';
 // OCR can read diagram text without reading any model characters.
 if(!reads.some(r=>/\b[A-Z0-9?_-]*\d[A-Z0-9?_-]*\b/i.test(r.ocr_text||'')))return 'OCR found no model characters to confirm the AI reading; verify before using.';
 return 'OCR did not confirm the AI reading; verify before using.';
}
export function visionReadMessage(read:any){
 if(read.vision_text)return read.vision_text;
 if(read.vision_status==='not_returned')return 'Not returned by AI';
 if(read.vision_status==='invalid')return 'Discarded invalid crop entry';
 if(read.vision_status==='not_attempted')return 'No usable AI reply';
 return 'Unreadable';
}
