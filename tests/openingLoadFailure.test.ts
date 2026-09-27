import {it,expect} from 'vitest';
import {openingLoadFailure} from '../field-app/src/lib/openingLoadFailure';
it('offers sign-in for a rejected session without calling the record missing',()=>{
 expect(openingLoadFailure({status:401})).toMatchObject({title:'Sign-in required',signIn:true,retry:false});
});
it.each([403,404])('keeps authorization failure %s distinct from connection recovery',status=>{
 const result=openingLoadFailure({status});expect(result.signIn).toBe(false);expect(result.retry).toBe(false);
 expect(result.message).toContain('account');
});
it.each([new TypeError('network'),{status:500},new SyntaxError('invalid response')])('offers bounded user retry for service failure',error=>{
 expect(openingLoadFailure(error)).toMatchObject({title:'Unable to load opening',retry:true,signIn:false});
});
