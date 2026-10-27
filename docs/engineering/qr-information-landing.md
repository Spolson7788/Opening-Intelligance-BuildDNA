# QR information-first landing — local candidate

Approved public fields are facility display name, building display name, and
existing opening code. All other data remains protected. The existing QR URL and
identity stay unchanged; `/field/opening/by-qr/:token` becomes the information
landing and its explicit protected-details link uses the existing tenant checks.
No migration, new credential, grant, label generation, or hosted configuration is
part of this change. The staging site's Netlify access gate remains required.

The public API uses a separate three-field projection/DTO and sends `no-store`.
It returns no internal IDs, private media, account identity, or operational data,
including for callers with an authenticated browser. Invalid, unknown, draft and
retired identities have the same unavailable result. The client accepts only the
exact DTO, never caches it in the Field database, and aborts/ignores stale reads.
Same-origin cookies preserve the staging gate; no app bearer token is read/sent.

The landing mounts outside the AuthProvider/account banner/worker lifecycle.
QR sign-in and protected-details navigation do not start sync or requeue stopped
operations. A tab-local gate prevents a previously running pass from dispatching
subsequent requests after navigation, including photo reserve/PUT/confirm steps.
Already submitted requests can complete and record receipts. Their effects are
not undone. Other tabs' workers are unaffected. Visiting an ordinary work route
resumes its normal worker; stopped authorization operations still require their
existing recovery path. No retained media is cleared.

Rate handling is a constant-space ceiling of 60 requests per minute per server
process, not a global or per-user guarantee. Public activation requires a separate
decision about the hosting access layer and platform-wide abuse/capacity controls.
One caller can consume a process's allowance; cold instances multiply capacity.
Names/code are intentionally public when that later activation is approved.

Validation commands:
- `npx vitest run --config tests/publicQr.config.ts`
- `npx vitest run --config tests/qrLandingUi.config.ts`
- `npx vitest run --config tests/qrSync.config.ts`
- `npx vitest run --config tests/privateReadLocal.config.ts`

Coverage includes exact response allowlist, local SQL projection/status filtering,
authenticated/anonymous/foreign-tenant controls, invalid paths, no-store requests,
malformed/HTML responses, interrupted login/return paths, delayed responses,
repeated navigation, retained operations and all photo dispatch boundaries.
Independent review found and then verified corrections to warm-navigation sync,
QR-login recovery and trailing-slash classification. No remaining local packaging
blockers were reported. Hosted and physical-phone acceptance of this new landing
has not run. No deployment or public-access change is authorized by this artifact.
