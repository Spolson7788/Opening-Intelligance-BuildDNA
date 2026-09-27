import { expect, it } from 'vitest';
import { readLoginForm } from '../field-app/src/lib/loginForm';
it('reads replacement native form values without relying on a change-event state',()=>{
 const form = new FormData();
 form.set('email','old@example.invalid');form.set('password','old-test-secret');
 form.set('email','  stg-tech-a@oi-nonprod.invalid  ');
 form.set('password','autofilled-test-secret');
 expect(readLoginForm(form)).toEqual({email:'stg-tech-a@oi-nonprod.invalid',password:'autofilled-test-secret'});
});
it('preserves intentional password whitespace and unicode exactly',()=>{
 const form = new FormData();form.set('email','a@example.invalid');form.set('password','  test-é-密碼  ');
 expect(readLoginForm(form).password).toBe('  test-é-密碼  ');
});
it('does not stringify missing fields into credentials',()=>{
 expect(readLoginForm(new FormData())).toEqual({email:'',password:''});
});
