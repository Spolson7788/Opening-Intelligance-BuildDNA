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
