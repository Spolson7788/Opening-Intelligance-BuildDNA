# Connected video corrections

Extends protected-staging source 1d18bf24b9aa1ab58d5ea4f8d0cb54d5714dd1c7 on the same prepare/pr2-protected-staging branch. No migration, paid call, publication, deployment, frozen R8 or video change.

Changes:
- Exact technician POST permissions for same-organization property, building and opening creation. No portfolio creation, bulk import or team administration. Existing handler parent-ownership checks remain. Inspectors do not gain setup permissions.
- Field App connected setup page uses existing API contracts and native Healthcare selector; supports single/paired door configuration and explicit fire classification. Creating the hierarchy requires connectivity; no offline creation claim.
- Technician/inspector photo reservation recovery allowed through the existing ownership-checked endpoint. Tests include owning technician, different organization, and another technician in the same organization.
- QR URL built from required OI_FIELD_APP_URL, never request Host. HTTPS only, no credentials/query/fragment; preserves deployed subpath and targets opening/by-qr. QR quiet zone four modules. QR labels include authoritative facility/building/opening metadata.
- Existing Dashboard window.print control retained. Field App exposes Print / save label after confirmed connected completion, using window.print. Label width2.4in, height at least3in, QR1.75in; Letter portrait,100%,0.4in page margin, headers/footers off. Actual PDF rendering, independent decoding and physical printing are NOT claimed verified.
- Login retains protected destination, allowing QR retrieval after authentication. Existing server tenant authorization retained.

Free verification: API TypeScript and both frontend builds pass. Four targeted suites total50 tests pass under isolated PGlite, using serialized pg pool to suit its socket adapter; this does not establish concurrent remote behavior. Subsequent changed metadata assertions pass5 QR tests; same-org actor denial passes23 offline API tests. Earlier DB adapter startup/connection failures are superseded by successful reproducible harness scripts/test-connected-video.mjs. No connected suite pass inferred.

Required staging configuration for a subsequent separately approved deployment:
OI_FIELD_APP_URL=https://pr2-staging--oi-offline-sync-pr2-api-nonproduction.netlify.app/field/
Scope Functions; exact branch pr2-staging. Existing secrets unchanged. Missing/invalid configuration refuses QR generation; never emits an inferred public destination.

Recording readiness remains HELD for connected scenes until approved synthetic accounts exist and the real browser/API run verifies login/reload/logout, second-session access, pending/drain, retry/retention/isolation, paired hierarchy, finish and purchasing gates. First exercise and inspect the existing Dashboard print control, then Field App print, save PDF and independently decode the printed image. Do not use an image-generated PDF as evidence of browser printing. No physical-printer claim without a physical test.

Do not create legacy DB tables for recovery. Existing cleanup scope must track exact created IDs/keys. Current approved staging dataset counts must be revised before exceeding them; this implementation does not itself create any data. Scene identities must be synthetic and labeled; never relabel approved local-only footage as connected.

Known limitations unchanged: no server logout-token revocation (client sign-out clears auth, server checks current DB user/role); no client lease renewal/fencing guarantee, deleted-photo undo window, generic arbitrary-object sweep or facility deletion UI. Configured Field App -> backend -> Dashboard retrieval is the intended direction. Two-way editing is not claimed.
