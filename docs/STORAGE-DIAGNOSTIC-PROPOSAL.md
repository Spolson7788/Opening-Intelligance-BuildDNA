# Temporary isolated staging storage comparison — publication proposal

Local implementation only. Published ce4828ee / 6adcb694c4f910510adc0501 remains unchanged.

Purpose: establish whether the running Function uses exactly the existing provider Access key ID supplied privately by the operator. No new credentials, storage calls, uploads, deletes, provider policy or database grant changes.

## Implemented scope

The PowerShell helper takes only the existing Access key ID through hidden interactive input. It validates exact lowercase 32-hex format, without trimming, and computes HMAC-SHA256 with a public random 32-byte nonce and UUID run ID. Domain is JSON [oi-storage-identity-v1, b64bf33c-a131-4ae2-b2b0-9aec16e9f77b, runId, exactKey]. It never asks for the Secret access key. After the operator types COPY, only the comparison proof enters the clipboard; after saving, Enter replaces the clipboard with harmless text. No credential or proof file/output is generated. Clipboard history/cloud sync may retain the proof; process-managed string memory cannot be guaranteed zeroized. The raw provider key is never placed on the clipboard by this helper, and the agent must not inspect its window during entry.

A first-party React Dashboard page at /dashboard/staging-storage-comparison uses normal authenticated app requests; it has no credential/candidate field and no auto-run. It renders six fixed boolean checks, never raw responses or errors. It is hidden outside the exact staging hostname and Organization A admin UI; server checks remain authoritative. It does not switch the Field session.

The Function passes platform site/deploy/context directly into the router. The router requires exact new site b64bf33c-a131-4ae2-b2b0-9aec16e9f77b, platform production context, valid platform deploy ID, matching runtime SITE_ID and diagnostic-specific OI_STORAGE_DIAGNOSTIC_CONTEXT, one named current active admin in Organization A 66c07d0e-887d-4b78-a6bc-181b2a644c34, and a configured absolute window at most 15 minutes. Existing auth rechecks role/activity/session against the database. Expiry is checked before and after authentication. Missing/malformed configuration, wrong site/context/principal, expiry or database failure denies access. POST accepts no candidate/body/query data. Responses are no-store. No logs are added by this diagnostic.

Six booleans: accessKeyMatches, endpointMatches, regionMatches, bucketMatches, accessKeyPresent, secretKeyPresent. The endpoint, region and bucket checks are against boaoedvyvifppuklbwad, us-west-1 and oi-video-workflows-media. No raw key, digest, nonce, signature or URL is returned. Proof is run-bound, not preassigned-deploy-bound, avoiding Netlify's assigned-deploy-ID configuration cycle; published candidate/deploy attribution is independently verified. The same fixed result may be reread within the window; callers cannot submit guesses. The run's high-entropy expected proof does not authorize anything.

## Exact approval requested before execution

1. Prepare a fresh public nonce/run UUID and resolve Synthetic Admin A's UUID from nonsecret metadata. Let the user privately run the tested helper and save only its proof into OI_STORAGE_DIAGNOSTIC_EXPECTED, marked Secret, Production context, Functions only. No real user input is requested yet.
2. Configure only this new site's Production Functions settings: OI_STORAGE_DIAGNOSTIC_ENABLED=true; START and END (absolute ISO UTC, <=15 minutes); RUN_ID; ADMIN; NONCE; EXPECTED. Rely on Netlify's documented runtime SITE_ID=b64bf33c-a131-4ae2-b2b0-9aec16e9f77b and configure OI_STORAGE_DIAGNOSTIC_CONTEXT=production. Never attempt to set or override reserved SITE_ID or CONTEXT. CONTEXT is build-only; the trusted Function context separately must report production. Never infer Functions availability from build-only settings. No changes to S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, permissions or credentials.
3. Publish the final reviewed diagnostic commit to this private site only, verify attribution/private gate, let the designated admin click Compare configured identity, and record only the six booleans. User may need to sign into React Dashboard as A; do not read tokens or disturb A Field queue. No photo retry until result reviewed.
4. Remove the diagnostic settings and publish a cleanup build removing its route/UI/helper integration; verify 404. Automatic absolute expiry closes access even before cleanup. No extension of the window without renewed explicit scope.

Cost: normally 15 existing Netlify credits for diagnostic publication plus 15 for cleanup = 30 existing credits. Confirm available balance/current pricing first; no recharge/add-ons and no increased monthly budget. No new persistent access. If operation is uncertain, inspect before retrying.

## Interpretation and rollback

Mismatch proves runtime identity differs from the privately supplied reference. Match proves equality only, not that the operator selected the correct provider project/key, that the secret matches, or that the provider recognizes it. Do not claim this alone conclusively resolves every InvalidAccessKeyId cause. Provider identity recognition remains the next boundary if equality and all target checks pass. Do not regenerate/revoke keys automatically.

Rollback to ce4828ee removes diagnostic behavior but does not remove synthetic records/images. Disable/expiry closes it without any storage deletion. Credentials and current photo reservation remain untouched.

## Validation

Dedicated mocked-database route/auth tests; UI DOM tests; trusted Function-context wiring tests; independent Windows PowerShell HMAC vector and six negative input cases. No hosted diagnostic, real credential entry or new PostgreSQL/schema acceptance claimed. Full configured release build and final counts are recorded in the delivery report. Independent review specifically found/fixed final-newline validation and authentication-spanning-expiry issues.

Broader cross-tenant API panel is deferred. No token extraction or browser API scripting workaround was added.
