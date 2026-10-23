# WP3B/C local lifecycle validation — 2026-10-23

Branch: feature/video-facility-workflows. Builds on WP3A 4a53de3; connected baseline ce40fa8. No push, deployment, hosted migration, external notification, purchase or recognition work. Protected Oct20 recovery artifacts untouched.

## Implemented

Explicit physical positions and atomic component replacement preserve predecessor identity, tracker, evidence, original service IDs/costs and warranties. Successor has a new identity on the same leaf/frame position, begins unverified, and requires review. Exactly one active instance per explicitly assigned position; no automatic legacy position backfill. Retired instances are excluded from current completion, labels, purchasing, condition and capital-cost projections; history retains them.

Append-only downtime records support whole-opening or multiple component attribution, confirmed/estimated/unknown boundaries, and corrections. Overlaps union once within each availability category, with guaranteed/possible totals and unresolved uncertainty. Restricted and unavailable totals remain separate. No service events or job costs are copied.

Product and labor warranty records retain issuer, terms, trigger, date certainty, stated expiry, exclusions, claim instructions, proof/source references, and correction history on the physical instance. No coverage calculation or claim is created. Proof references are recorded text, not verified document versions.

Field lifecycle UI is linked from installation history (also reachable through the actual Facility Dashboard history link). Writes retain existing admin/facilities_manager scope and require connection; uncertain retries freeze the original command. Historical details are visible to authorized readers. Separate React Dashboard retired-service attribution corrected.

## Validation

28 focused tests pass: lifecycle operations 5, installation API 8, installation/time UI 5, service requests 5, revisions 5. Each database suite used a fresh disposable PGlite runner. API and Field TypeScript checks pass; Field and actual Facility Dashboard builds pass. Independent read-only review found and prompted fixes for a SELECT-only view row-lock privilege issue, retired-service attribution, omitted read-only history details, and partial UTC input entry. No new permission grants were used for the purchasing fix.

Local Edge browser with synthetic accounts/data verified: unknown installation then appended estimated-year correction; inactive-leaf replacement retains old tracker and both product/labor records; new successor remains on inactive leaf; two overlapping two-hour outages display 180 minutes, not 240, including explicit paired-component attribution. Desktop and 390px iframe layout inspected. Browser inspection prompted readable stacked fields and explicit UTC text input. Screenshots are in ../acceptance-evidence/wp3-*.png. These are local browser checks, not physical mobile tests.

## Limits and remaining acceptance

No installed real PostgreSQL was found in prior availability checks; concurrent PostgreSQL lock behavior remains unverified. PGlite and mocks do not establish that guarantee. No hosted schema, production, physical QR/printer, camera, or device acceptance was attempted. Separate React Dashboard type checking could not complete because local React/router/chart dependencies are absent; no software was installed. The actual Facility Dashboard build succeeds.

Lifecycle records are online-only, histories currently unpaginated, warranty proof-version verification remains future work. Legacy dates remain unreviewed. Historical physical positions require explicit selection; no inferred backfill. This bounded lifecycle package does not finish the broader video plan (catalogs, estimates, immutable PO workflow, invoices/budget reconciliation remain separate).

One command attempt timed out in automatic approval review; read-only verification established it had not executed, the permitted single retry succeeded. No unresolved denial. Local browser full-page screenshot capture timed out; viewport capture succeeded.

Final browser regression also verified character-by-character UTC typing with an unknown end; the partial-entry fix is covered by the fifth UI test. Fresh local origins were used to avoid a previously cached service worker bundle.
