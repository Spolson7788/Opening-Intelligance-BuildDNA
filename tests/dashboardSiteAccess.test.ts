import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApiError } from '../dashboard/src/lib/api';
import { isSiteAccessLoginError, siteAccessRenewalUrl, SITE_ACCESS_LOGIN_MESSAGE } from '../dashboard/src/lib/siteAccess';
import { siteAccessRenewalUrl as fieldRenewalUrl } from '../field-app/src/lib/siteAccess';
import { loginErrorMessage } from '../dashboard/src/lib/scheduleUi';
const REF = '123e4567-e89b-42d3-a456-426614174000';
const page = readFileSync('dashboard/src/pages/LoginPage.tsx', 'utf8');

describe('dashboard sign-in: private gate detection and renew link', () => {
  it('treats a 401/403 without the app reference as the hosting gate', () => {
    expect(isSiteAccessLoginError(new ApiError(401, 'login_failed'))).toBe(true);
    expect(isSiteAccessLoginError(new ApiError(403, 'login_failed'))).toBe(true);
  });
  it('does not flag real app answers or other failures', () => {
    expect(isSiteAccessLoginError(new ApiError(401, 'invalid_credentials', REF))).toBe(false);
    expect(isSiteAccessLoginError(new ApiError(403, 'account_deactivated', REF))).toBe(false);
    expect(isSiteAccessLoginError(new ApiError(502, 'login_failed'))).toBe(false);
    expect(isSiteAccessLoginError(new TypeError('Failed to fetch'))).toBe(false);
    expect(loginErrorMessage(new ApiError(401, 'invalid_credentials', REF))).toBe("Email or password didn't match. Try again.");
  });
  it('builds the same allow-listed URL as the field app', () => {
    for (const o of ['https://oi-video-workflows-staging.netlify.app', 'https://oi-connected-release-candidate.netlify.app', 'https://evil.example'])
      expect(siteAccessRenewalUrl(o)).toBe(fieldRenewalUrl(o));
    expect(siteAccessRenewalUrl('https://oi-video-workflows-staging.netlify.app')).toBe('https://app.netlify.com/edge-access?domain=oi-video-workflows-staging.netlify.app');
  });
  it('renders the gate message, the renew button and a standing link on the sign-in page', () => {
    expect(SITE_ACCESS_LOGIN_MESSAGE).toContain('password has not been rejected');
    expect(page).toContain('siteAccessRenewalUrl(window.location.origin)');
    expect(page).toMatch(/siteAccess && renewalUrl && <a [^>]*href=\{renewalUrl\} target="_blank" rel="noreferrer">Renew private site access<\/a>/);
    expect(page).toMatch(/\{renewalUrl && <p[^>]*><a href=\{renewalUrl\} target="_blank" rel="noreferrer">Renew private site access<\/a>/);
  });
});