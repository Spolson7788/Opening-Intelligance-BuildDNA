import {it,expect} from 'vitest';
import {openingLoadFailure} from '../field-app/src/lib/openingLoadFailure';
it('offers hosting renewal instead of repeating app sign-in for a hosting refusal', () => {
 expect(openingLoadFailure({status:401,hostingAccessRequired:true})).toMatchObject({title:'Staging website access required',signIn:false,retry:false});
 expect(openingLoadFailure({status:403,hostingAccessRequired:true}).message).toContain('Renew staging access');
});
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
