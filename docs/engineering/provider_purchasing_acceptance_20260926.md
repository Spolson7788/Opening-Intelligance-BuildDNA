# Provider assignment and purchasing acceptance — 2026-09-26

Nonproduction only. PR9, feat/field-territory-integration. No existing assignment or document approval is seeded by the migration.

## Implemented

- Explicit facility-to-provider-organization assignments; only the owning company's administrator can grant/revoke. Provider administrators cannot redelegate customer facilities. No email-domain or location-derived grants.
- Fresh assignment predicate shared by opening, component, service, sync and photo routes; facility search, nested picker and approved Dashboard snapshot use that predicate too. Owner-only property configuration/report routes remain owner-only.
- Canonical approval record pins manufacturer, model, component type, HTTPS supporting document URL/hash, approving owner administrator and provenance. Generic uploads and technician identity edits cannot approve evidence. A changed identity no longer matches its approval.
- Single-opening and bulk review use the same server gate. Whole hierarchy, reviewed/assessed parts and completion are checked again. Good/serviceable items are excluded. An unresolved intended replacement or unfinished intended opening blocks the entire review and yields zero request items. All-serviceable results yield no replacements. No sending/ordering endpoint is introduced.
- Dashboard Review purchasing invokes the live API, clears old output, rejects a result from a changed facility/account and states nothing is sent or ordered.
- Technician frame/leaf/complete permissions added to match the existing authorized field workflow.
- Provider-initiated photo deletion retries retain the photograph's organization identity.

## Verification completed before deployment

- API TypeScript build passes.
- Real PGlite/API suite: provider/purchasing, facility Dashboard, offline sync API, dependencies and photo immutability: 31 tests passed.
- Provider/purchasing + paired opening + role permissions: 30 tests passed (overlap with preceding count; do not add as unique tests).
- Offline model/database/flush recovery and hosting suite: 47 tests passed. These are local tests, including controlled/mocked network conditions.
- Built Dashboard controlled-API browser test: refresh, preserved facility selection and purchasing refusal display pass.
- Staging migration applied to ioqfdcehnhnqpnqawwvo. Both new tables have RLS enabled and anon/authenticated grants revoked. Advisor reports two informational RLS-without-policy notices, intentional because the trusted application API owns access. No client Data API policy is intended.

Advisor explanation: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

## Acceptance still required

Do not label production-ready based on these tests. Hosted two-company sessions, provider revocation on direct API/private media/queued writes, interrupted upload and response-loss recovery must be observed against the protected deployment. A previously issued media URL remains usable until its existing 300-second expiry; revocation denies new API retrieval requests, not already-downloaded bytes.

Assignment and evidence approval administration are owner-admin API operations, not a completed management UI. The API requires exact organization/component IDs. No real provider has been granted access.

## Administration contract

PUT /api/provider-assignments/:propertyId/:providerOrganizationId with {active: boolean}.
PUT /api/purchasing/approvals/:componentId with {document_url, document_sha256, provenance: technician_selected|oi_established, active: boolean}.
POST /api/purchasing/review with {opening_ids: [UUID,...]} (1–100).
GET /api/openings/:id/purchasing-eligibility shares the same review rules.

Approval records document an authorized review; the service does not fetch, interpret or authenticate the contents of a supplied manufacturer document automatically. Approvers must inspect the evidence before approving it.

Rollback: revert application preview to prior artifact; retain additive tables with no new grants. Revoke synthetic test assignments if any are subsequently created. Do not drop records or change production access.
