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

Netlify CLI has no authenticated session; available connector deploy-site cannot upload/select this reviewed candidate. No web deployment performed. No merge to production.

## Release sequence and rollback
Finish the provider mapping on the actual Field App API, test all direct record/media/queue paths, deploy reviewed nonproduction web/API candidates, then run two-account Auth/HTTP/browser acceptance, offline replay/revocation, and connected record/photo checks. Preserve existing deployment artifacts and synthetic evidence. Additive geography columns may remain during web rollback. Revert provider helper functions only using the prior verified definitions; do not drop associations or alter customer ownership.
