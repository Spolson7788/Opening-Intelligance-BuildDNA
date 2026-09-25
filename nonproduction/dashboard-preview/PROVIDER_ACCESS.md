# Company facility access — implementation candidate

Status: implemented and locally tested on `feat/provider-facility-access`, based on video candidate `44ceaa8e8bf4d0156f1e23c23f138c435766db09`. No database migration or deployment has been performed. The approved recording deployment is unchanged.

## Behavior

An authenticated account receives access through an administrator-approved provider membership and an active provider/facility assignment. Email domains and editable account metadata grant no access. Customer organization ownership and existing explicit customer permissions remain independent. Multiple providers can deliberately be assigned the same facility without copying its records.

A provider technician sees all facilities assigned to that company. The administrator can set a two-letter home state; the picker defaults to it. All authorized states and text search (name, address, city, ZIP) remain available. Filtering never grants permissions. No matches clears the previous facility and records. Missing state data remains searchable with All authorized states. Store standardized uppercase state codes on facilities for consistent matching.

Writes require both an admin/tech provider role and `allow_write=true` on the assignment. Viewer and read-only assignments cannot write. Revocation is checked against current database rows, including queue receipt replay.

This change covers the connected preview Dashboard and its opening editor. It has not been integrated into the separate recognition Field App. GPS proximity, a territory picker, and a provider administration screen are not included. The schema reserves a territory label for later work; it is not used as an authorization rule.

## Trusted administrator provisioning

Apply only in a separate integration environment after reviewing the migration against that environment's schema. The fixture schema used by tests is not a production bootstrap or a deployment script.

1. Verify the person's authenticated user ID and confirmed company email through the existing Auth administration process. Independently confirm employer authorization. Do not enroll a person solely because their email has a company domain.
2. Create a `service_providers` row and record its UUID.
3. Insert `provider_memberships(provider_id,user_id,role,home_state)` using the verified IDs. Default role is viewer. Use tech only for an approved technician. No browser account may provision itself.
4. Associate approved existing facility UUIDs through `facility_provider_assignments(facility_id,provider_id,allow_write,territory)`. Writes default to false; explicitly enable them when appropriate. Do not change the facility's customer organization.
5. Confirm Vortex and DH Pace test accounts cannot access one another's unshared records using real API and private-storage requests. Test shared access only on an explicitly shared fixture.
6. Disable the membership or assignment (`active=false`) to revoke that grant. Audit independent customer memberships too: another valid grant intentionally continues to authorize access. Never use customer memberships to enroll provider technicians.

Use a trusted database administrator or server-only service role; never put that credential in client code. Record the authorizing administrator and approval evidence in your operational audit process. The new timestamps record when associations were created, not a full administrative audit trail.

## Validation

From `nonproduction/dashboard-preview`:

```
npm ci
npx playwright install chromium
npm run test:provider
```

Passed: 14 Node tests, including real PostgreSQL RLS evaluation through PGlite with authenticated/anonymous roles, existing organization and contract SQL regressions, two-provider isolation, metadata spoofing, viewer/write ceilings, revocation and queue replay, private object/photo/service visibility, owner preservation, and explicit sharing. Search tests cover pagination beyond 500, errors, home-state defaults and filters.

Passed: Chromium mobile-width checks of both pages with mocked API responses: home state, all states, text search, clearing zero-match results and no runtime errors. These are browser behavior tests, not live Supabase acceptance.

Fixtures reconstruct the existing preview baseline and hierarchy from the recovered preview schema/checkpoint; they contain no production user data. Tests add disposable synthetic records, local auth.uid and storage.foldername stand-ins, then apply the actual SQL contract and migrations. PGlite does not exercise the hosted Auth, PostgREST or Storage HTTP services.

## Release gates and limitations

Before release, run hosted Supabase security/performance advisors and connected API/storage acceptance in a separate integration project; those have not been run. Verify confirmed-email onboarding, existing policies and grants against that project, and test the real offline queue when permission is revoked. Deploy migration before pages. Merge/release is separate from this candidate and must not change the video candidate in place.

Already downloaded files or offline data cannot be remotely recalled. Previously issued signed image URLs remain usable until their expiry (currently 120 seconds). The new rules control subsequent authorized requests, not previously disclosed bytes.

Rollback: restore the previous versions of is_member, can_write, oi_is_member and inspection policies from the base candidate, and restore its pages. Export any new associations before considering table removal. Do not drop associations as a routine rollback. No automatic organization or facility backfill is performed.
