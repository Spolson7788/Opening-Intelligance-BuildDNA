// A hosting access gate can return 401/403 or an HTML sign-in page before
// the application runs. HTTP status alone does not reject app credentials.
export function loginFailureMessage(status: number, code: string, reference?: string): string {
  const appResponse = Boolean(reference && /^[0-9a-f-]{36}$/.test(reference));
  if (appResponse && status === 401 && code === 'invalid_credentials') {
    return "Email or password didn't match. Try again.";
  }
  if (appResponse && status === 403 && code === 'account_deactivated') {
    return 'This account is deactivated. Contact an administrator.';
  }
  if (status === 401 || status === 403) {
    return `Site access could not be verified (HTTP ${status}). Your app password has not been rejected. Renew access to this private preview before trying again.`;
  }
  return `Sign-in service is unavailable (HTTP ${status}). Your credentials have not been confirmed rejected.`;
}

const savedMessage = 'Password saved. Sign in with the password you just chose.';
export async function recoveryResponse(response: Response): Promise<{saved: boolean; message: string}> {
  const json = response.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
  const body = json ? await response.json().catch(() => null) : null;
  if (response.ok && body?.message === savedMessage) return {saved: true, message: savedMessage};
  if (response.status === 400 && body?.error === 'invalid_or_expired_code') {
    return {saved: false, message: 'The recovery code is invalid, expired, already used, or does not match this email.'};
  }
  if (response.status === 400 && body?.error === 'invalid_recovery_request') {
    return {saved: false, message: 'Check the email, recovery code format, and password requirements.'};
  }
  if (response.status === 401 || response.status === 403 || !json) {
    return {saved: false, message: `The recovery service did not return an application response (HTTP ${response.status}). Access to this private preview may need renewal. Your password has not been confirmed changed.`};
  }
  return {saved: false, message: `Recovery service unavailable (HTTP ${response.status}). Your password has not been confirmed changed.`};
}
