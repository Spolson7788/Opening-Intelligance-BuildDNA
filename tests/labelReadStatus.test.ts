import {it,expect} from 'vitest';
import {labelConfirmationMessage,visionReadMessage} from '../field-app/src/lib/labelReadStatus';
it('does not claim OCR disagreement when it found no model characters',()=>{
 expect(labelConfirmationMessage([{ocr_status:'read',ocr_text:'spring adjustment',vision_text:'1040XP'}])).toContain('no model characters');
 expect(labelConfirmationMessage([{ocr_status:'read',ocr_text:'4040XP',ocr_model_conflicts:['4040XP']}])).toContain('conflicting model characters');
 expect(labelConfirmationMessage([{ocr_status:'timeout'}])).toContain('timed out');
});
it('distinguishes an absent AI read, invalid entry and an explicit empty read',()=>{
 expect(visionReadMessage({vision_status:'not_returned'})).toBe('Not returned by AI');
 expect(visionReadMessage({vision_status:'invalid'})).toBe('Discarded invalid crop entry');
 expect(visionReadMessage({vision_status:'unreadable',vision_text:''})).toBe('Unreadable');
});

import {displayPhotoReferences} from '../field-app/src/lib/labelReadStatus';
it('converts singular and plural source photo references without changing product numbers',()=>{
 expect(displayPhotoReferences('Photo 3 shows a rod; photos 0 and 2 do not. Series 7000; label 71??.')).toBe('Photo 4 shows a rod; photos 1 and 3 do not. Series 7000; label 71??.');
 expect(displayPhotoReferences('Photos 0, 1 and 2; photo 0’s label.')).toBe('Photos 1, 2 and 3; photo 1’s label.');
});
