/** Read native form values at submission, including browser autofill.
 * Passwords are preserved exactly; never trim or normalize a secret.
 */
export function readLoginForm(form: FormData): { email: string; password: string } {
  const email = form.get('email');
  const password = form.get('password');
  return {
    email: typeof email === 'string' ? email.trim() : '',
    password: typeof password === 'string' ? password : '',
  };
}
