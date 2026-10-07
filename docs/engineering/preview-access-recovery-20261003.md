# Private preview access recovery

The protected reference preview returned an HTTP 401 HTML `Login Redirect`
from Netlify for an unauthenticated `/health` request. The Field App screenshot
showed an uncorrelated 401 at sign-in. Navigating to `/health` in the user's
browser subsequently returned `{"status":"ok"}`, and the same app account
then signed in successfully. This establishes a hosting-access failure pattern;
it does not establish why the user's specific hosting session became invalid.

The Field App precaches its HTML and JavaScript for offline work. Its cached
screen can therefore open while the separate Netlify access session is no
longer accepted. A fetch receives Netlify's HTML redirect but does not execute
the embedded navigation script. Repeating app sign-in cannot renew that
hosting session. Earlier instructions to sign out of the app addressed the
wrong layer.

The fix checks the protected `/health` server once when the sign-in screen
opens, classifies hosting refusals separately from correlated app decisions,
and displays a **Renew staging access** link. The same notice handles a
hosting refusal during recognition or other API calls. It does not clear the
app's auth state or replay a failed write. Opening loading errors no longer
send a hosting refusal back into the app sign-in loop.

`/preview-access` is a network-only GET function. The existing Netlify gate
handles access first; after access is accepted, the function returns a
noncacheable 303 to `/field/login?preview_access=renewed`. Its destination is
fixed, so supplied query strings cannot create an open redirect. It accepts
no credentials, makes no database changes, and grants no app authorization.
The service worker excludes this path, `/health`, and `/api` from navigation
fallback. API requests explicitly use same-origin credentials and no-store.

Real application wrong-password, token-revocation, deactivated-account and
permission decisions remain distinct. The hosting gate is retained. Saved
offline operations are retained; unsaved form fields and selected recognition
photographs must be entered again after top-level renewal.

Validation includes mocked HTTP requests through the actual Field App API
wrapper, recovery redirect/method tests, existing credential-message and
opening/cache authorization regressions, API type checking and Field App
build. These tests establish recovery behavior; they do not establish a
successful live provider recognition run or explain the original session
expiry mechanism.
