# Technical Storage identity preparation

Local only. No identity, credentials, policy, grant, flag or deployment activation.

The dedicated Supabase Auth identity is not an OI application account and receives no facility, provider or purchasing membership. Supabase Auth issues its tokens; no custom signer, service_role credential or human session is used at runtime.

Production Functions configuration proposed: OI_STORAGE_IDENTITY_EMAIL, OI_STORAGE_IDENTITY_USER_ID, secret OI_STORAGE_IDENTITY_PASSWORD, and nonprivileged OI_COMMERCIAL_STORAGE_API_KEY. No refresh-token environment setting or fixed bearer. Exact isolated site/context capability checks remain in place.

One independent session is retained in each warm Function instance's memory. Password sign-in occurs on first commercial request. Tokens refresh on demand with a 60-second expiry margin, one shared in-flight promise, no timer or disk persistence. Response identity/issuer/role/audience/expiry must match. Claims parsing is a consistency check on the fixed HTTPS issuer response, not standalone JWT signature verification. Storage verifies JWT authorization independently.

Definitive auth failure blocks that warm provider. Network/429/5xx failures use cooldown, never an internal retry loop; valid Retry-After is respected. A lost refresh response may be retried with the same refresh token only after cooldown; definitive rejection stops it, without password fallback. Upload POST is never automatically replayed by the adapter. Existing read-back/checksum reconciliation remains.

Deployment readiness conditions: verify email/password provider is enabled and server sign-in does not require interactive CAPTCHA; verify project single-session enforcement is disabled because instances own independent sessions. Do not change either setting silently. Token endpoint documented default150 requests/5minutes/IP, burst30; cold-start fan-out shares those limits and per-instance cooldown is not a global limiter. This is bounded staging readiness, not proof of high-scale capacity. If actual session/rate settings conflict, hold activation and design a serialized credential broker rather than weakening controls.

Revocation: warm-instance refresh rejection is not global revocation. New instances can sign in while the machine password remains valid, and old JWTs may last until expiry. Remove the subject's Storage policy allowance and disable the Auth identity for emergency revocation, then revoke sessions and rotate/update its password under explicit approval. Do not delete the identity or objects. Removing Netlify settings alone is not token revocation. Account setup, password custody, session controls and policy installation require exact activation approval.

Storage policies must bind auth.uid(), not email or user-editable metadata. Restrict exact private bucket/document UUID prefix and allowed HTTP operations. No photos, list/sign, overwrite/delete, bucket mutation or public application access. This identity spans document tenants; API authorization remains the tenant boundary. Existing project administrators/broad S3 credentials can alter objects: no WORM guarantee or new retention duration. PDF header/size checks are not malware scanning.

Independent review corrected UUID validation and Retry-After handling and requested lost-refresh-response coverage. Hosted Storage HTTP behavior and actual account/session settings remain untested. Local tests must not be presented as hosted acceptance.
