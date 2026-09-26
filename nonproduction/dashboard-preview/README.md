# OI Dashboard connected-preview candidate

**HOLD — not recording-ready and not a field-release candidate.**

This is a separate nonproduction Dashboard and opening-review editor targeting only Supabase preview `lujfnhvkmllnpxkihhno`. It does not replace the Home Screen Field Identifier, production, frozen PR2 deployment, or R8. The original recognition workflow has not been migrated into this editor.

## Implemented

- Separate opening, frame, active/inactive leaves and UUID component records.
- Dashboard reads the new hierarchy; material is not treated as a manufacturer.
- Mobile layout and password-reset controls. Live email delivery/callback approval remains unverified.
- Atomic facility creation and creator membership, including street/city/state/ZIP fields.
- Scoped photograph selection, private retrieval, IndexedDB queue and stable operation IDs.
- Server replay returns `already_applied`; changed payload with the same operation ID is refused.
- Complete-opening purchasing review, serviceable/refused exclusions, approved product/document matching and invalidation after component changes.

## Evidence scope

`tests/browser-results.json`: 13 passing local Chromium tests with mocked backend responses. These cover rendering, mobile fit, queue persistence, response-loss replay and account-switch behavior. They are **not connected acceptance**.

`tests/contract.sql`: passing rolled-back authenticated-role SQL tests on the preview database. Covers facility access, address fields, repeat components, idempotency, completion, purchasing gates and facility isolation. The test's approved-product record is synthetic and disappears on rollback.

Two normally provisioned, email-confirmed preview accounts now exist. Organization mapping and the STG-DASH-R1 demonstration dataset are seeded. Database role tests passed; no connected browser acceptance is claimed. The current security advisor warns that leaked-password protection is disabled; no database RLS findings were returned.

## Required before recording

1. Sign in to the protected preview with the two provisioned demonstration accounts. No passwords belong in this repository or the handoff.
2. Deploy this candidate only to a separate protected nonproduction preview, pin the source commit and artifact hashes, and allow its recovery callback in preview Auth settings.
3. Verify the seeded STG-DASH-R1 dataset in the deployed Dashboard. Its catalog entry uses an archived manufacturer-authored CR441 document hosted by a distributor; approval is for demonstration only.
4. Perform a new real browser upload, synchronized metadata write, reload, byte retention and authorized retrieval. Replay the exact operation over the API and confirm `already_applied` without duplicate records or objects.
5. Run exact record AND photograph denial with the second account. Organization membership now gates facility permissions; role-level SQL denial passes, but connected account and photograph denial remain open.
6. Validate end-to-end password recovery, completion, purchasing and service-history display on that one deployment.

## Other recording-visible limits

- Preview warning remains displayed.
- One demonstration catalog entry is seeded; no physical product identification or compatibility approval is claimed.
- Editor provides manual component review, not image recognition, physical QR printing or purchase/email sending.
- Structure saves require connectivity; only component and photo operations are queued.
- No conflict-resolution UI for simultaneous edits; components currently use last accepted write.
- The recovered Dashboard still contains legacy inspection-age language. Do not record compliance claims without a separate review.
- Organization mapping and a synthetic dataset exist; photographs and browser verification remain outstanding.
- Preview branch's original bootstrap failure status was not reset; earlier manual baseline repairs remain prerequisites.

## Reproduce

Run `python3 build.py`, then serve `site/` locally. Run the browser suite with Playwright 1.51.1 and its Chromium runtime. SQL files apply **in order**, only after the previously saved schema/hierarchy checkpoint:

1. `sql/connected_contract.sql`
2. `sql/serialize_component_changes.sql`
3. `sql/purchasing_snapshot_lock.sql`
4. `sql/product_approval_gate.sql`
5. `sql/service_write_roles.sql`
6. `supabase/migrations/20260923191344_organization_access.sql` (requires the empty pre-dataset facility baseline)

These migrations are already applied to the named preview. Do not apply them twice or to production. `tests/contract.sql` rolls all its fixtures back.

Build output contains a publishable browser key, not an administrative key. Private account preparation files are excluded from this package.
