# Approved Facility Dashboard connected to the Field App API

Nonproduction integration. Layout source is the approved static Dashboard from
provider-access candidate a9cb5e3e26f070bd1669b4d1e2c5a70e9829a6a0; its old
Supabase transport is replaced at build time, not its presentation.

The new `/facility-dashboard/` entry uses the Field App session on the same
protected origin. Sign in through `/field/scan`, then use Facility Dashboard.
Every network request goes through the existing API's current-user and company
checks. The facility snapshot endpoint reads canonical Field App rows in one SQL
statement and returns 404 for a different company's facility. Photo bytes still
require the existing authorized private-photo endpoint; snapshots contain only
photo identity/association metadata, no storage key or signed URL.

There is no database mirror, no cross-backend email matching, no new credential,
and no migration or copying of the separate preview demonstration records.
State and territory filters apply only to server-authorized company facilities.
Same-org authorization does not yet implement customer/provider assignment sharing.

Use Refresh saved records after a Field App save. There is no realtime subscription.
Opening scores use the canonical API score. Component condition ratings retain
the approved Dashboard display scale. Structures without a recorded condition
remain unverified; no condition is inferred from completion. Parts not yet saved
remain visible as an empty opening, without counting the placeholder as a part.

The preview-only deficiency/service-request workflow is not supported by this
backend. This page labels the connected records as service history. It does not
assert that absence of a deficiency means compliance or closure. Purchasing
approval/document gating remains a separate release blocker; this read-only
Dashboard does not submit, email or order anything.

Validation:
- `tests/facilityDashboard.test.ts`: canonical hierarchy, updated condition,
  photo association, absent raw storage URL, cross-company reads denied,
  missing authentication denied and deactivated account denied.
- `scripts/test-integrated-dashboard-browser.cjs`: actual generated UI against
  controlled API data, including canonical opening score and refreshed condition.
- Hosted verification is recorded in PR9 after deployment; local tests alone
  are not production acceptance.
