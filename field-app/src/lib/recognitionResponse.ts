// A successful HTTP status alone is not an analysis result. Reject empty or
// malformed responses before the view can silently clear its progress state.
export function requireRecognitionResult(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    typeof value.run_id!=='string'||!value.run_id||
    !value.suggestion||typeof value.suggestion!=='object'||Array.isArray(value.suggestion)||
    typeof value.status!=='string')throw Error('recognition_result_missing');
 return value;
}
