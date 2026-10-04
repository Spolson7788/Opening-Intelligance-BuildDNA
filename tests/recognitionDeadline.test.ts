import {it,expect,vi} from 'vitest';
import {withinRecognitionBudget} from '../src/services/recognitionDeadline';
it('returns usable completed work immediately',async()=>{expect(await withinRecognitionBudget(Promise.resolve('photo'),Date.now()+1000,()=> 'fallback')).toBe('photo');});
it('returns a partial fallback when optional work never completes',async()=>{
 vi.useFakeTimers();
 try{const result=withinRecognitionBudget(new Promise<string>(()=>{}),Date.now()+24000,()=> 'partial');await vi.advanceTimersByTimeAsync(24000);expect(await result).toBe('partial');expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
});
it('does not conceal an actual failure before the deadline',async()=>{await expect(withinRecognitionBudget(Promise.reject(Error('provider')),Date.now()+1000,()=> 'partial')).rejects.toThrow('provider');});


it('rejects empty successful responses instead of leaving the recognition form blank',async()=>{
 const {requireRecognitionResult}=await import('../field-app/src/lib/recognitionResponse');
 for(const value of [null,{},[],{run_id:'run',status:'reference_evidence',suggestion:null},{run_id:'run',status:'reference_evidence',suggestion:[]}])expect(()=>requireRecognitionResult(value)).toThrow('recognition_result_missing');
 const valid={run_id:'run',status:'no_reference_match',suggestion:{manufacturer:null,model:null}};
 expect(requireRecognitionResult(valid)).toBe(valid);
});
