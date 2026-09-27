# Company and territory integration — 26 September 2026

Status: partial implementation; NOT production-ready and NOT a unified connected release.

## Applied nonproduction database changes
- Dashboard preview `lujfnhvkmllnpxkihhno`: provider_facility_access and provider_home_territory. Administrator-approved company memberships plus facility assignments; current-row permission checks; home territory/state defaults. Hosted authenticated-role SQL verified cross-company denial, self-escalation denial and immediate revocation. Synthetic rows rolled back. Auth/REST/private-object HTTP acceptance remains outstanding.
- Field App staging `ioqfdcehnhnqpnqawwvo` (`opening-intelligence-staging`): additive properties.service_territory and users.home_state/home_territory. Verified against the existing nonproduction checkpoint and project metadata. Automatic review initially rejected an insufficiently-established target identity; succeeded after those checks. No production writes.

## This Field App candidate
- Server facility-search endpoint always limits results to the current database-verified user's organization, then narrows by state, service area and text. Defaults come from administrator-managed user records, not email domain or editable token claims.
- Setup screen shows My Territory, State and facility text search; filter changes clear stale facility/building selections.
- Opening cache entries are bound to the user and organization. Untagged old entries are not disclosed. 401/403/404 never fall back to cached content; network/server outages may show that principal's cache. In-flight responses are rejected after an account switch.
- Existing queued writes retain their server-side current-authorization checks; no new cross-organization permissions granted.

## Validation
- API and Field App builds pass.
- API search/company isolation and role permissions: 17 tests pass using isolated PGlite.
- Offline database: 13 tests pass, including user/company cache isolation.
- HTTP denial versus offline-cache behavior: 4 tests pass.
- Mobile browser checks against actual built Field App, mocked API: home territory/state, filter intersections and stale-selection clearing pass.
- Browser script requires Playwright 1.51.1; supply OI_PLAYWRIGHT_MODULE pointing at its installed module, or install it in the test environment. This is not hosted acceptance.

## Remaining integration work
The preview uses Supabase Auth, facilities/opening_assemblies and provider assignments. The separate Field App uses API users, properties/buildings/openings and organization ownership. The provider assignment model is NOT yet bridged into that API; shared customer-owned facilities across providers are not implemented there. The recognition video build is a third, frozen local-only artifact and is unchanged.

GPS sorting and self-service administrator screens are not implemented. No company membership is inferred from email suffix. No real company assignments were provisioned without verified user/facility identities.

Netlify browser authentication was verified on 26 September. The existing project
`6430c57d-8a98-43bc-ba25-94007dd244f2` has production branch
`production-disabled`, only `pr2-staging` branch deployments, and pull-request
previews enabled after explicit user approval. PR 9 is open for review and remains unmerged. Existing database/storage/JWT settings remain in place. Added Functions-scoped
Deploy Preview values for OI_FIELD_APP_URL and the public Supabase Root 2021
CA certificate. The missing preview CA initially prevented database TLS.
Certificate and hostname verification remain enabled; no credentials were exposed.

PR 9 now includes an isolated Deploy Preview build configuration. Its build
guard accepts only this nonproduction site plus PR 9's exact source branch,
or the existing pr2-staging branch deployment. Eight guard tests pass,
including rejection of production, another site, another PR and another
branch. Builds publish build-info.json with commit, branch, context and
acceptance-pending status. The guard uses Netlify HEAD for the PR source branch and BRANCH for branch deployments.

After rebasing on the actual remote staging candidate, API/Field App builds
and the mobile mocked-API check pass again. The combined offline sync,
current-role permissions, facility search and QR suite passes 46 tests.
Protected Deploy Preview 9 deployed successfully: commit
`ad5b42a592a3be50a42fa6c3d505f26b45279690`, deployment
`6ab7fa3bd79aa59c1b3aae9a`, state ready, context deploy-preview,
production published_at null. No production merge or deployment.

## Hosted checks on 26 September
- Secure Field App sign-in succeeds after the preview CA correction.
- Live facility search: CA + QA West returns only California; FL + QA East
  returns only Florida; FL + QA West returns zero. Changing filters clears
  the selected facility and disables building selection. Text search further
  narrows the intersection. These are live API/database checks, not mocks.
- Test records are explicitly SYNTHETIC QA 20260926. Properties
  f7260926-0001-4000-8000-000000000001 and
  f7260926-0001-4000-8000-000000000002 belong to OI Staging Test.
- Created paired opening 7f2cf151-0579-489a-a00a-94594b873297 through the UI.
  Frame and separate active/inactive leaves synchronized; independent database
  read confirms one frame and two correctly associated leaves.
- Found a live completion blocker: Edit Hardware omitted review/condition/
  identity/replacement controls although Add Hardware and the API support them.
  Added those controls, preserving leaf association. Real mobile UI with mocked
  API verifies pending-to-reviewed, changed condition/identity/replacement and
  values reloaded from the saved response. Field App build passes. Hosted
  verification passed on commit 591826ce4ab99bd7fac72bbf482c13d3218e728e: the
  pending active-leaf closer was reviewed, and the opening completed. Both
  closers retain their distinct active/inactive associations.
- Synthetic service event synchronized. Synthetic photo uploaded to private
  storage, rendered after reload, and database join confirmed attachment to
  QA-ACTIVE-CLOSER on the active leaf. Photo id
  2eac9114-988d-47ed-820d-d0ab4f304a2e. No signed URL retained in this report.
- Found service dates displayed one day early in Pacific time, despite the
  database date being correct. Field App and API-backed Dashboard event-date
  formatting now preserves UTC calendar dates. Field App mobile regression in
  America/Los_Angeles passes; both app builds pass. Hosted check pending.
- Existing offline app shell needed a second reload after deployment to show
  the new version; queued data was retained. This is a release rollout caveat.
- No two-account hosted isolation, offline interruption, private-photo or
  approved static Dashboard synchronization pass is claimed.

## Release sequence and rollback
Finish the provider mapping on the actual Field App API, test all direct record/media/queue paths, deploy reviewed nonproduction web/API candidates, then run two-account Auth/HTTP/browser acceptance, offline replay/revocation, and connected record/photo checks. Preserve existing deployment artifacts and synthetic evidence. Additive geography columns may remain during web rollback. Revert provider helper functions only using the prior verified definitions; do not drop associations or alter customer ownership.
