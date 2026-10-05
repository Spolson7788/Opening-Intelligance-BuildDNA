// A successful HTTP status alone is not an analysis result. Reject empty or
// malformed responses before the view can silently clear its progress state.
export function requireRecognitionResult(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    typeof value.run_id!=='string'||!value.run_id||
    !value.suggestion||typeof value.suggestion!=='object'||Array.isArray(value.suggestion)||
    !Object.keys(value.suggestion).length||
    typeof value.status!=='string'||['running','failed','awaiting_saved_result'].includes(value.status))throw Error('recognition_result_missing');
 return value;
}
