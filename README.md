# Opening Intelligence Platform — MVP API

A starting point for the commercial building opening asset intelligence platform.
This is intentionally minimal: it proves the core data model and gives you a
working API to build the field-capture PWA and dashboard against.

## What's here

- `migrations/001_init.sql` — full Postgres schema (portfolios → properties →
  buildings → openings → hardware/service/inspection/photos → health score history)
- `src/routes/openings.ts` — create openings, look up by QR token, generate
  printable QR codes, recompute health scores, list/filter for the dashboard
- `src/routes/events.ts` — log service events and inspection events (the two
  things technicians/inspectors do in the field)
- `src/services/healthScore.ts` — rules-based (not AI) health score, deliberately
  simple and auditable — see the "factors" breakdown returned with every score

## What's deliberately NOT here yet

Per the MVP scoping: no AI/computer vision, no CMMS/ERP/BIM integrations beyond
a future CSV export, no native mobile app, no SSO. Build these once you have
2-3 pilot customers validating the core workflow, not before.

## Deploying this

For local dev, keep reading below. To actually put this on the internet
(required before any pilot customer can use it), see **[DEPLOYMENT.md](./DEPLOYMENT.md)**
— covers the recommended stack (Railway + Vercel + Cloudflare R2), CORS
configuration between the three separately-hosted pieces, and a working
end-to-end verification checklist.

## Setup

1. Install Postgres locally or spin up a free instance (Supabase, Railway, Neon
   all work).
2. Copy `.env.example` to `.env` and set `DATABASE_URL` (and `JWT_SECRET` —
   the app refuses to start without one).
3. Install dependencies and run migrations:
   ```
   npm install
   npm run migrate
   ```
   This applies every file under `migrations/` in order and tracks what's
   been applied in a `schema_migrations` table, so it's safe to run again on
   every deploy — already-applied migrations are skipped, not re-run.
4. Start the dev server:
   ```
   npm run dev
   ```
5. API is live at `http://localhost:3000`. Try:
   ```
   curl http://localhost:3000/health
   ```

## Core workflow this API supports

0. **Create your first organization.** `POST /api/auth/signup` creates a
   brand-new organization plus its first admin user in one call and returns
   a token — this is now the normal path (the dashboard's signup screen
   uses it). Direct SQL insert into `organizations` is still fine for
   internal/testing use, but customers don't need it anymore. Once an org
   exists, its admin can invite more users via `POST /api/auth/register`
   (requires an authenticated admin — it derives the organization from the
   caller's own token rather than trusting a client-supplied `organization_id`,
   which was a real gap in an earlier version of this endpoint: anyone who
   guessed another customer's org UUID could previously have added themselves
   as an admin to it).
1. Admin creates a `building`, then creates `openings` under it
   (`POST /api/openings`) — each gets a unique `qr_token`.
2. Print the QR (`GET /api/openings/:id/qr-code`) and tag the physical door.
3. Field tech scans the QR → app calls `GET /api/openings/by-qr/:qrToken` →
   sees/edits the opening record, logs hardware, takes photos.
4. Service visits and inspections get logged via `POST /api/events/service-events`
   and `POST /api/events/inspection-events`.
5. After any new event, call `POST /api/openings/:id/recompute-health-score`
   to update the score (in production, trigger this automatically via a
   background job or DB trigger rather than calling it manually).
6. `GET /api/openings?max_health_score=50` powers the "openings needing
   attention" dashboard view — this is the screen that sells the pilot renewal.

## Testing

```
npm test
```

Runs the full suite (52 tests) against a real Postgres database — not
mocked. By default it connects to
`postgres://postgres:postgres@localhost:5432/opening_intel_test`; override
with `TEST_DATABASE_URL` if yours differs. The test run **drops and
recreates that database fresh every time** (see `tests/globalSetup.ts`) —
never point `TEST_DATABASE_URL` at anything you care about.

Worth reading `tests/tenantIsolation.test.ts` and `tests/numericTypes.test.ts`
specifically — they're regression tests for real bugs this project shipped
with at some point (a cross-org auth gap, and numeric fields silently
arriving as strings), each with a comment explaining what actually broke
and why the test exists, not just what it checks.

## Demo data for pilot conversations

Walking into a pilot conversation with an empty dashboard doesn't demo well.
`npm run seed:demo` populates a realistic portfolio against whatever
`DATABASE_URL` you point it at — one property, two buildings, ~28-30
openings with real hardware, service history, and inspection results,
including a handful deliberately tuned to score low (two distinct
narratives: a neglected opening nobody's serviced in years, and a chronic
one serviced repeatedly and still failing) so the "Needs Attention" card and
worst-first sort actually have something to show. It reuses the real
`computeHealthScore` logic from `dist/services/healthScore.js` (run
`npm run build` first) rather than faking plausible-looking numbers, and is
idempotent — re-running with the same `DEMO_EMAIL` reuses the existing org
instead of creating a duplicate. Prints a login at the end.

## Immediate next build steps (in order)

1. ~~**Auth**~~ — done. JWT-based, scoped to `organization_id`. See
   `src/middleware/auth.ts` and `src/routes/auth.ts`. Every openings/events
   query is now tenant-scoped via `src/db/tenantScope.ts`. Requires a
   `JWT_SECRET` env var (see `.env.example`) — the app fails to start
   without one, on purpose.
2. ~~**Field capture PWA**~~ — done, in `field-app/`. Offline-first via
   IndexedDB (cache + outbox), camera QR scan with manual fallback, dark
   high-contrast UI built for stairwells/mechanical rooms. See its own README.
3. ~~**Dashboard frontend**~~ — done, in `dashboard/`. Portfolio-wide stat
   cards, health score distribution chart, sortable/filterable table. Light,
   boardroom-ready theme — deliberately different from the field app's dark
   theme, but sharing the asset-plate visual motif so they read as one
   product. See its own README for what's not built yet (property
   drill-down, per-opening detail, CSV export, map view).
4. ~~**Hardware component endpoints**~~ — done. Full CRUD in
   `src/routes/hardware.ts`, tenant-scoped through the opening it belongs to.
   Includes a portfolio-wide search endpoint (`GET /api/hardware?manufacturer=...`)
   — this is what makes "find every Cal-Royal cylinder installed before 2019"
   a real query instead of a pitch-deck hypothetical.
5. ~~**Photo upload**~~ — done. Presigned-URL flow (`src/routes/photos.ts`,
   `src/services/storage.ts`) so photo bytes go directly from the field app to
   storage, never through the API server. Works with real AWS S3 or any
   S3-compatible endpoint (Supabase Storage, R2, MinIO) via env config — see
   `.env.example`. The field app now has working photo capture with
   geotagging; **offline photo queueing is not built** (photos require a
   live connection, unlike service/inspection events) — see the field app's
   README for why that's a deliberately deferred piece, not an oversight.
6. ~~**Dashboard property/building drill-down**~~ — done. Required adding
   `src/routes/portfolio.ts` to the API first (there was previously no way to
   list, or even create, properties/buildings at all — only openings). Now
   supports the full hierarchy: `POST /api/portfolio/portfolios`, `/properties`,
   `/buildings`, plus `GET /api/portfolio/properties` (nested with buildings)
   for the picker. `GET /api/openings` now also accepts `?property_id=`.
7. ~~**Per-opening detail view on the dashboard**~~ — done, in
   `dashboard/src/pages/OpeningDetailPage.tsx`. Read-only: hardware table,
   full service/inspection history, photo grid. Table rows in the main
   dashboard are now clickable.
8. ~~**CSV export**~~ — done. `src/routes/export.ts`, two endpoints:
   `GET /api/export/openings.csv` (respects the same filters as the
   dashboard) and `GET /api/export/hardware.csv` (pairs with the hardware
   search endpoint — "find every Cal-Royal cylinder before 2019" now has a
   one-click path to a spreadsheet, not just a JSON response). Wired into
   the dashboard as an "Export CSV" button that exports exactly the
   currently-filtered view.
9. ~~**Auth for creating orgs/users**~~ — done. `POST /api/auth/signup`
   (public, creates org + first admin user, auto-issues a token) and a fixed
   `POST /api/auth/register` (now requires an authenticated admin, derives
   the org from the caller's token instead of trusting client input — see
   the workflow note above for why the old version was a real security gap).
   Dashboard has a signup screen at `/signup`.
10. ~~**Offline photo queueing**~~ — done, in the field app. Photo capture
    now writes the image blob to IndexedDB immediately (same instant-save
    pattern as service/inspection events), and the sync manager flushes it
    — presign, upload, confirm — once connectivity returns. A queued photo
    shows in the opening's photo grid immediately, dimmed with a "Queued"
    badge, and automatically resolves to the real synced version once
    uploaded. See the field app's README for the presigned-URL-expiry
    handling this required.
11. ~~**Cloud deployment**~~ — done. `DEPLOYMENT.md` covers the recommended
    stack (Railway + Vercel + Cloudflare R2) end to end. Two real gaps this
    surfaced and fixed along the way: (1) there was no CORS configuration at
    all — everything only worked because local dev used a same-origin proxy,
    which would have silently broken the moment the frontends were deployed
    to their own domains; (2) `npm run migrate` was referenced in
    `package.json` but the script didn't exist — there was no real way to
    apply migrations to a managed Postgres instance you can't `psql` into
    directly. Both are now built and verified end-to-end against a real
    Postgres instance (signup → org/property/building/opening creation →
    listing → CSV export), not just type-checked.
12. ~~**Demo seed data**~~ — done (`npm run seed:demo`). Building this
    surfaced a real, live bug that had been sitting undetected through every
    previous type-check: `health_score` (and every other `NUMERIC` column)
    came back from the API as a **string**, not a number — node-postgres's
    default behavior, invisible to TypeScript's type annotations because
    the mismatch is only at the JSON boundary. This silently broke two
    things on the dashboard: the average health score stat card (string
    concatenation instead of addition — garbage output) and the default
    "worst first" sort (lexicographic instead of numeric — `"9.00"` sorted
    after `"80.00"`). Found by actually running seeded data through the
    real API end-to-end, not by `tsc --noEmit`. Fixed once, at the source
    (`src/db/pool.ts`, a global numeric type parser), so every client gets
    real numbers rather than patching each frontend separately.
13. ~~**Field app manual-entry lookup was broken**~~ — found and fixed while
    demoing the field app. The manual code-entry field was labeled and
    placeholder'd as "opening code" (e.g. `AZ-PHX-BLDG03-F02-0214` — the
    human-readable code printed on the actual door tag), but the code
    silently treated whatever was typed as the internal `qr_token` (an
    opaque UUID a technician never sees) and called `/openings/by-qr/:token`.
    Typing the code you can actually read off a door would always fail with
    "not found." Fixed with a real, separate lookup path: added
    `GET /api/openings/by-code/:openingCode` and split the field app's scan
    page so a camera scan (which decodes the qr_token from the printed QR)
    and manual entry (which uses the human-readable code) now resolve
    correctly through different endpoints instead of one being silently
    wrong. Verified end-to-end with a real headless-browser walkthrough
    (login → type a real opening_code → correct opening loads), not just a
    type-check.
14. ~~**Automated tests / CI pipeline**~~ — done. `vitest` + `supertest`
    against a real Postgres (not mocked) — 46 tests across 8 files (at the
    time this was built; see item 18 below for the current count), run via
    `npm test`. Includes dedicated regression tests for every real bug found
    so far: tenant isolation (the cross-org auth gap), numeric field types
    (the string-vs-number bug), and the by-code/by-qr manual-entry bug —
    each with a comment explaining what it's actually guarding against, not
    just what it asserts. `.github/workflows/test.yml` runs the full suite
    (type-check + tests) against a Postgres service container on every push
    and PR to `main`. Frontend tests (dashboard, field-app) are not part of
    this — see the next item.
15. ~~**Hardware component editing**~~ — done, in the field app. Hardware
    cards on the opening detail page are now tappable → edit page with
    Save and a confirm-before-delete flow, using the already-tested
    `PATCH`/`DELETE /api/hardware/:id`. Scoped to the field app on purpose —
    the dashboard stays read-only reporting, corrections happen where the
    tech actually is. Building this surfaced a real bug: the shared
    `authedFetch` helper called `res.json()` unconditionally, which throws
    on the empty body a 204 (DELETE) response returns — meaning the delete
    button would have crashed the first time anyone tapped it. Fixed in the
    shared helper (and preemptively in the dashboard's identical helper too,
    even though nothing calls a DELETE endpoint there yet).
16. ~~**Property/building creation UI**~~ — done, in the dashboard
    (`/properties/new`). One necessary backend change first: `/api/auth/signup`
    now auto-creates a default portfolio in the same transaction — portfolios
    aren't a concept either frontend exposes, so a brand-new org previously
    had nowhere to attach a property to. Verified end-to-end with a real
    headless-browser walkthrough (signup → create property → add building →
    confirmed both rows actually exist in the database), not just a
    type-check. Full test suite re-run after the signup change — still 45/45.
17. **Frontend tests** — the 52 tests above cover the API only. Neither the
    dashboard nor the field app has any automated coverage yet.
18. ~~**Bulk CSV import**~~ — done. This was flagged as the single highest-
    priority gap: without it, onboarding a real pilot property (hundreds of
    openings) meant either one-by-one API calls or manually scanning every
    door with the field app before any data existed to scan into.
    `POST /api/openings/bulk-import` (`src/routes/openings.ts`) takes an array
    of rows and inserts each independently — a handful of bad rows (a
    duplicate code, a typo'd type) don't sink an otherwise-good 300-row
    batch; the response reports per-row success/failure (HTTP 207
    Multi-Status). 6 dedicated tests, including the partial-success case
    specifically. Dashboard UI at `/openings/import`: CSV upload parsed
    client-side (`papaparse`, not hand-rolled — CSV quoting edge cases are
    exactly the kind of thing worth a real library for), a preview table
    showing which rows are ready vs. will be skipped and why, chunked
    submission (the API caps at 1000 rows/request), and a downloadable CSV
    template. Verified with a real headless-browser walkthrough using a CSV
    with one intentionally invalid row — confirmed via direct database query
    that exactly the 4 good rows landed and the bad one didn't, not just
    that the UI showed a plausible-looking success message.
19. ~~**Batch QR label printing**~~ — done, the natural pairing with bulk
    import: import 200 openings from a CSV, then print all 200 QR labels in
    one pass instead of one at a time. `GET /api/openings/qr-codes?building_id=`
    (`src/routes/openings.ts`) returns every opening in a building with its
    QR code generated, in one request. Building this caught a real bug
    before it shipped: the route was initially registered *after*
    `GET /:id`, which is a single-segment wildcard — Express would have
    matched `/qr-codes` against `/:id` first (treating "qr-codes" as an
    opening id) and the batch endpoint would never actually have been
    reachable, despite type-checking cleanly and looking correct in
    isolation. Caught by testing the real route through the real router, not
    by reading the code. Fixed by moving the route above `/:id`, with a
    dedicated regression test asserting the route is genuinely reachable.
    Dashboard UI at `/openings/print-labels`: property/building select, a
    print-ready label grid (QR + opening code + location, dashed cut lines),
    using the browser's native print/Save-as-PDF rather than generating PDFs
    server-side. Verified two ways: a normal screenshot of the screen view,
    and — the test that actually matters for a print feature — rendering the
    real output via Chrome's print-media emulation into an actual PDF, then
    checking pixel content distribution across the page to confirm the label
    grid renders correctly (evenly distributed content matching the expected
    row/column count) rather than a blank page or a broken layout.
20. ~~**Fire door / life-safety compliance PDF report**~~ — done. This was
    the strongest wedge named in the original assessment — an artifact a
    facilities manager can actually hand to an auditor or fire marshal,
    unlike a CSV. `GET /api/export/compliance-report.pdf?property_id=`
    (`src/services/complianceReport.ts`, built with `pdfkit`) defaults to
    fire-rated/life-safety openings (`?scope=all` for everything), grouped
    by building, with color-coded PASS/FAIL/NOT-INSPECTED status and inline
    failure notes. Building this caught a real bug: placing the footer page
    number at `page.height - 30` fell inside PDFKit's bottom-margin overflow
    zone, which silently added a blank extra page to *every* report,
    regardless of content length. Caught by actually rendering a sample PDF
    and checking pixel content distribution per page — not by reading the
    code — and fixed by zeroing the bottom margin temporarily while writing
    the footer. 6 tests, and the PDF response is verified byte-for-byte
    (`%PDF` magic-number check), not just a 200 status.
21. ~~**Capital forecast view**~~ — done, the other half of the original
    positioning: translating health score into a multi-year replacement
    budget a facilities exec can defend in a budget meeting.
    `GET /api/portfolio/capital-forecast?property_id=` buckets openings by
    health score (urgent <50 / near-term 50-74 / healthy 75+ / unassessed)
    broken down by opening type — deliberately returns raw counts, not a
    dollar figure, since per-unit replacement cost is a real assumption that
    varies by market and belongs in the dashboard where it's adjustable, not
    baked into the API as a guess presented as fact. Dashboard page at
    `/capital-forecast`: a chart, a breakdown table, and editable per-type
    cost inputs that recompute totals live. Verified about as rigorously as
    anything in this project: computed the expected bucket counts by hand
    from a direct SQL query against real seeded data, confirmed the API
    matched exactly, then loaded the actual page in a headless browser and
    extracted the *rendered* dollar figures — $7,900 urgent+near-term,
    $25,800 total — which matched the hand calculation to the dollar.
22. ~~**Video support for openings**~~ — done. Photos were image-only
    (`image/jpeg`, `png`, `webp`, `heic`); now `photo_upload` also accepts
    `video/mp4` and `video/quicktime`. Schema gained a `media_type` column
    (migration `003_video_support.sql`), derived server-side from
    `content_type` — never trusted as a separate client-supplied field, so
    there's exactly one place (`src/services/storage.ts`) that decides
    what counts as a photo vs. a video. Both frontends' photo grids now
    render `<video controls>` instead of `<img>` when appropriate; the
    field app's capture button splits into "+ Add Photo" / "+ Add Video"
    with a 100MB client-side size cap on video (**not** server-enforced —
    presigned PUT URLs don't support a Content-Length-Range condition the
    way presigned POST does, so a determined client could bypass this; worth
    revisiting before this handles untrusted uploads at real scale). Added
    `tests/photos.test.ts` from scratch — there was no dedicated photo
    test coverage before this. Verified about as concretely as possible: no
    real S3 in this sandbox, so a real MP4 was generated with `ffmpeg`,
    served locally, and inserted as a real database record; a headless
    browser then confirmed the rendered `<video>` element's `readyState`
    was 4 (`HAVE_ENOUGH_DATA`) with `videoWidth`/`videoHeight`/`duration`
    matching the actual encoded file — proof the browser's media engine
    genuinely decoded it, not just that a tag with some `src` existed in
    the DOM.
23. ~~**Hardware cost & supplier info, wired into the capital forecast**~~ —
    done. Each hardware part can now carry `unit_cost`, `supplier_name`, and
    `supplier_contact` (migration `004_hardware_cost_supplier.sql`) — the
    "one place, not three lookups" request: manufacturer, part number,
    price, and who to call, all on the same record, editable from the field
    app and visible read-only on the dashboard's hardware table.
    More significant than the new fields themselves is what they're wired
    into: the capital forecast (§21) previously only ever guessed — "doors
    cost about $800" — for every door regardless of what's actually on it.
    It now blends real numbers with that guess: `GET /api/portfolio/capital-forecast`
    sums real `unit_cost` values per opening into `known_cost_total`, and
    only falls back to the adjustable per-type estimate for openings that
    have no priced hardware at all (tracked separately as
    `needing_estimate_by_type`, specifically so a priced opening is never
    double-counted under both a real number and a generic guess). The
    dashboard now shows the split plainly — "$X based on real priced
    hardware parts on file · $Y from the adjustable estimate" — rather than
    presenting a blended number as if it were uniformly one or the other.
    3 new capital-forecast tests plus 3 new hardware tests (including a
    numeric-type check, the same bug class fixed earlier in this project).
    Full suite: **84/84 passing**. Verified with the same rigor as
    everything else in this list: created a door with two priced parts
    ($340.50 + $150) via the real API, confirmed the response summed to
    exactly `490.5`, confirmed exactly one unpriced door fell into the
    fallback bucket, then loaded the actual dashboard in a headless browser
    and confirmed the rendered stat card read **$1,291** — the hand-computed
    total ($491 real + $800 estimated, rounded) to the dollar.
24. ~~**Real hardware taxonomy, `is_electrified`, and bulk hardware CSV
    import**~~ — done. Prompted by a direct correction: the original 9
    component types didn't reflect what a real door actually carries — a
    single opening commonly has a lockset, 3 hinges, a closer, a keypad,
    and (if electrified) an electric strike, power transfer, maglock, or
    request-to-exit device, none of which fit the original list. Expanded
    to 14 types (migration `005_electrified_and_hardware_types.sql`), and
    added `is_electrified` as an opening-level flag — mirroring
    `fire_rated`/`life_safety_critical` rather than trying to infer it from
    which parts happen to be listed, since "is this door electrified" is a
    real yes/no fact independent of how completely its hardware has been
    catalogued.
    More significant than the schema change: **bulk hardware CSV import**
    (`POST /api/hardware/bulk-import`), a deliberately separate flow from
    bulk-creating openings. A door with 7 hardware line items would be
    absurd to import as "one row = one opening + one part" (repeating every
    opening detail 7 times) — so each row instead references the opening by
    its human-readable `opening_code`, which is globally unique. This also
    means the endpoint needs no `building_id` at all: one CSV can attach
    parts to openings spanning any building or property the org owns.
    Dashboard UI at `/hardware/import` (CSV upload, template, live preview,
    per-row results — same pattern as the openings importer). 8 new API
    tests, including one that specifically imports 7 parts onto a single
    opening (the actual scenario this was built for) and one confirming a
    guessed `opening_code` from another org correctly resolves to "not
    found" rather than leaking existence across tenants. Full suite:
    **92/92 passing**. Verified beyond the test suite: created a real
    electrified opening via the API, then — in an actual headless browser —
    uploaded a CSV through the dashboard's new import page with 7 valid
    rows (including a keypad and an electric strike, the new types this was
    built for) plus 1 deliberately bad row referencing a nonexistent
    opening code. The UI correctly reported 7 created / 1 failed, and a
    direct API cross-check afterward confirmed exactly those 7 parts exist
    in the database with exactly the manufacturers and costs from the CSV
    — not just that the upload "succeeded," but that what landed in
    Postgres matches the file byte-for-byte on the fields that matter.
25. ~~**Manual "New Opening" form + full property address fields**~~ — done.
    Prompted by a direct question about what the New Property setup was
    missing. Two real gaps, both closed:
    (1) The property form only ever collected name/city/state/type, even
    though the API had accepted `address_line1` and `postal_code` since the
    property-creation endpoint was first built — the form simply never
    exposed inputs for data the backend already wanted. Now it does.
    (2) The more consequential one: there was **no way to create a single
    opening by hand, anywhere, in either app.** Bulk CSV import was
    genuinely the *only* path — meaning even adding one forgotten door to
    an otherwise-complete building meant downloading a template, filling a
    spreadsheet, and re-uploading it. New page at `/openings/new`: property
    → building → opening code, type, floor, location, the three boolean
    flags (fire-rated, life-safety, electrified), with a "keep this
    building selected, clear the form" option for entering several by hand
    back-to-back without re-selecting anything. No new API endpoints needed
    — `POST /api/openings` already existed and was already tested; this
    was purely a missing frontend for a real backend capability.
    Verified end-to-end in a real headless browser: created a property with
    a full street address, then two openings in sequence using the "add
    another" flow (one fire-rated and electrified, one plain) — then
    queried Postgres **directly**, bypassing the UI entirely, and every
    field matched exactly what was typed, including confirming the reset
    between openings correctly cleared the checkboxes back to false rather
    than leaking state from the first entry into the second.
26. ~~**Per-part tracker ID + shipment tracking**~~ — done. Every hardware
    part now gets a permanent, auto-generated tracker ID (`TRK-XXXXXXXX`,
    migration `006_hardware_tracking.sql`) — server-generated only, exactly
    like `openings.qr_token`; a client cannot set or override it (tested
    explicitly, including someone trying to smuggle a specific value in).
    Alongside it: a manufacturer serial number field, and real shipment
    fields — carrier, tracking number, status (not shipped → ordered →
    shipped → in transit → delivered → installed), and expected/shipped/
    delivered dates. Deliberate scope boundary, stated plainly rather than
    implied: this does **not** call any carrier API for live status — no
    UPS/FedEx credentials, no polling, no webhooks. What it does instead is
    build the real tracking-page URL for UPS, FedEx, and USPS from the
    stored tracking number, so a "Track Shipment" link takes you straight
    to the carrier's own live page — most of the practical value, none of
    the integration burden.
    The migration itself got a real test most migrations in this project
    skipped: rather than only checking it applies to an empty database, I
    specifically inserted real hardware rows *before* the `tracker_id`
    column existed, then applied the migration and confirmed the backfill
    assigned correct, unique IDs to pre-existing data — the scenario that
    actually matters for a real deployment, not just a fresh install.
    7 new tests (auto-generation, client-override rejection, uniqueness
    across parts, full shipment lifecycle, invalid-status rejection).
    Full suite: **99/99 passing**. Both frontends updated — field app forms
    capture serial number and shipment info with the tracker ID shown
    asset-plate style; dashboard's hardware table gained Tracker and
    Shipment columns with a live "Track ↗" link; the hardware CSV importer
    accepts all the new columns. Verified end-to-end: uploaded a CSV with a
    real-format UPS tracking number through the actual browser, then pulled
    the *rendered* link's `href` attribute out of the live DOM and confirmed
    it was `https://www.ups.com/track?tracknum=1Z999AA10123456784` — built
    correctly from user data, not a placeholder — and cross-checked the
    database directly to confirm both parts got distinct tracker IDs with
    every CSV field intact.
27. ~~**Compliance due-date alerts + portfolio-wide capital forecast
    rollup**~~ — done. Two features chosen deliberately as moats, not just
    features: things a competitor would need real time (or real customer
    data) to replicate, not just a dev team.
    **Compliance alerts** (`GET /api/portfolio/compliance-alerts`) surfaces
    every fire-rated/life-safety opening that's overdue, due within 30 days,
    or has never been inspected — NFPA 80 requires annual inspection, and
    this is the difference between a report you have to remember to check
    and something that actually tells you when you're at risk. Explicit
    scope boundary, stated plainly: this does **not** send real emails —
    no SendGrid/SES credentials, no delivery integration. It's the accurate
    detection logic and a live dashboard view; wiring actual email delivery
    on top is a separate, contained piece of work for whenever there's a
    real provider to send through. 9 tests specifically exercise the date
    math against a real clock (400 days ago → overdue, 350 days ago → due
    soon, 30 days ago → clean), not just the query structure.
    **Portfolio rollup** (`GET /api/portfolio/capital-forecast/rollup`) is
    the multi-property answer to the existing per-property capital
    forecast (§21) — a portfolio owner with 40 properties sees every one
    ranked by risk in a single view instead of clicking through 40
    dashboards, with the same adjustable per-type cost assumptions applying
    consistently whether you're looking at the rollup or drilling into one
    property. Deliberately a *separate* endpoint from `/capital-forecast`
    rather than making `property_id` optional on the existing route, so
    nothing that already depends on the single-property response shape
    could break. Learned from an earlier mistake in this exact project
    (`/qr-codes` being silently shadowed by `/:id`): added a dedicated
    regression test confirming `/capital-forecast/rollup` is genuinely
    reachable and not swallowed by its sibling route, on top of a test that
    plants a priced part on one property and asserts the dollar figure
    never bleeds into a second property's total.
    Full suite: **113/113 passing**. Verified end-to-end with two real
    properties in one org — one with an inspection dated 400 days back, one
    with a real $1,200 priced lockset — and confirmed every number the
    browser actually rendered matched the ground truth exactly: alert
    counts `[0, 1, 0, 1]`, and the rollup table reading $1,200 for the
    priced property, $800 (the default per-type estimate) for the unpriced
    one, summing to a portfolio total of $2,000 — to the dollar, the same
    way every dollar figure in this project has been checked.
28. ~~**Warranty expiration alerts + capital forecast as a downloadable
    PDF**~~ — done. Two reports chosen the same way item 27 was: extending
    a pattern that already works, not inventing a new one.
    **Warranty alerts** (`GET /api/portfolio/warranty-alerts`) closed a real
    gap found by checking the code, not by guessing: `warranty_expiration`
    has been captured on every hardware part since the cost/supplier work
    (§23), but nothing ever surfaced it — it was only visible by opening a
    raw CSV export and scrolling to that column. Same detection shape as
    compliance alerts (expired / expiring within 90 days / clean), reusing
    the same "don't make someone go looking" reasoning. The Alerts page now
    has Inspections and Warranties tabs sharing one property selector. 8
    tests cover the date-math boundaries the same rigorous way §27's did
    (10 days past due → expired, 45 days out → expiring soon, 200 days out
    → not flagged, no warranty date at all → correctly never flagged).
    **Capital forecast PDF export** (`GET /api/export/capital-forecast.pdf`)
    gives the forecast the same treatment the compliance report already
    got — something to attach to an email or bring into a capex meeting,
    not just a screen to share. Supports both single-property and
    portfolio-rollup modes from one endpoint, and accepts the same
    adjustable cost assumptions as the dashboard via a `costs` query
    param, so the PDF matches whatever's currently dialed in on screen
    rather than falling back to generic defaults. Reused the exact
    footer-margin fix learned from the compliance report's blank-page bug
    (§20) from the start this time, rather than rediscovering it — verified
    by rendering a real sample PDF and confirming it came back as exactly
    the expected page count. While spot-checking that sample by hand, the
    dollar figures initially looked wrong by exactly $1,200; traced it to
    the *test script*, not the code — the direct low-level test had omitted
    one cost type from the costs object, which the real HTTP route's
    default-merging would have filled in automatically. Recomputing against
    what was actually passed confirmed the math was correct all along, and
    is worth noting for exactly that reason: verification also means
    checking your own check before concluding something's broken.
    6 tests, using the same real `%PDF` magic-number check as the
    compliance report. Full suite: **127/127 passing**. Verified with the
    browser's actual download mechanism, not just an HTTP response check —
    created a real property and opening through the UI, clicked the real
    "Download PDF" button, captured the file Chrome actually wrote to disk,
    confirmed its magic number, and extracted its text to confirm the
    property name, opening count, and dollar figure all matched exactly
    what had just been created.
29. ~~**Team management**~~ — done. First of a longer list of ideas
    (work orders, audit trail, document storage, bulk edit, global search,
    custom fields, role-based access enforcement, recurring maintenance,
    inspector sign-off) intentionally built in dependency order — this one
    first because several of the others (assigning a work order, enforcing
    role-based access) need more than one real user in an org to mean
    anything. Turned out most of the backend already existed and had never
    been wired to anything: `POST /api/auth/register` (admin-only invite,
    with a real role enum) and JWT role-carrying were both already built
    and tested from the original cross-org security fix — there was just no
    UI, no way to list a team, and no way to deactivate anyone.
    Added `is_active` (migration `007_team_management.sql`) — soft
    deactivation, not deletion, same caution applied everywhere destructive
    actions come up in this project. Two safeguards, both tested explicitly:
    an admin can't deactivate their own account, and the *last* active admin
    in an org can't be demoted or deactivated by anyone, since either would
    leave an org with no one able to manage its own team. Login now checks
    `is_active` and returns a distinct `account_deactivated` error rather
    than a generic wrong-password message.
    One limitation stated plainly rather than glossed over: deactivation
    blocks *new* logins immediately, but an already-issued JWT (valid up to
    12h) isn't re-checked against the database on every request, so a
    just-deactivated user's existing session keeps working until it
    naturally expires. Fixing that fully means a DB lookup on every
    authenticated API call — a real performance tradeoff, not something to
    quietly take on without deciding it's worth it.
    8 new tests. Full suite: **135/135 passing**. Verified beyond the test
    suite, in a real browser: signed up a fresh org, invited a technician,
    changed their role to inspector via the dropdown, deactivated them —
    then queried Postgres directly and confirmed `role = inspector,
    is_active = false` matching every click exactly, and hit the login
    endpoint directly with the deactivated user's real credentials to
    confirm the actual server response was `{"error":"account_deactivated"}`,
    not inferred from a screenshot.
30. ~~**Role-based access enforcement**~~ — done. Second item on the list,
    built right after team management on purpose — enforcing roles that
    only ever applied to one user per org wouldn't have meant anything.
    The `role` column and JWT role-carrying already existed (from the
    original cross-org security fix), but were only ever checked on one
    route. Everything else — a "viewer" account could delete hardware, a
    "technician" could bulk-import 300 openings — had no restriction at all.
    Built as one central middleware (`src/middleware/permissions.ts`)
    applied to all 6 API routers, rather than scattering role checks across
    every individual route handler — a single place stating the whole
    policy, not dozens of small ones that could quietly drift out of sync
    with each other.
    Caught a real correctness bug before it ever shipped, not after:
    `req.path` inside a mounted sub-router reflects the path *relative to
    that router's mount point* (e.g. just `/abc123` inside a router mounted
    at `/api/hardware`), not the full URL — the initial full-path regex
    patterns would have silently matched nothing, ever, letting every
    request through regardless of role. Fixed by switching to
    `req.originalUrl`, which reflects the complete path regardless of
    mounting depth.
    The permission model itself, stated plainly: **admin** and
    **facilities_manager** get full access (team management stays
    additionally admin-only, per item 29). **technician** and **inspector**
    can do real field work — log service/inspection events, add/edit/delete
    hardware, capture photos, trigger a health score recompute — but can't
    create openings, run bulk imports, or set up properties. Both roles get
    identical write permissions on purpose: the app has no UI distinction
    between what a technician vs. an inspector logs, and guessing at a
    finer split without a real customer drawing that line would be exactly
    the kind of thing this project has consistently avoided doing on a
    guess. **viewer** is read-only, full stop.
    16 new dedicated tests, covering every role's allow/deny boundary
    explicitly — plus the full pre-existing 135-test suite re-run
    afterward specifically to catch any regression from a change this
    broad, since it touches every route in the API. Zero regressions.
    Full suite: **151/151 passing**.
    Also updated the dashboard to hide (not just block) the four
    setup-only actions — New Opening, Import Openings, Import Hardware,
    New Property — from roles that can't use them, since showing a button
    that just 403s is a bad experience even though the server-side block
    was already the real security boundary regardless of what the UI shows.
    Verified in a real browser, end to end: confirmed an admin sees all 8
    header buttons and a freshly-invited technician sees exactly 4 — then,
    the check that actually matters, had the technician's own browser
    session bypass the UI entirely and call the API directly with a raw
    `fetch()`, the same thing anyone with dev tools open could try, and
    got back exactly `{"status":403,"error":"insufficient_role_for_action"}`
    — proof the real boundary holds regardless of what's rendered on screen.
31. ~~**Audit trail**~~ — done. Third item on the list — "who changed what,
    when," built the same way permissions were: one central middleware
    (`src/middleware/auditLog.ts`) attached to all 7 routers, rather than
    scattering logging calls across every route handler.
    Real scope decisions, stated plainly rather than left implicit: only
    successful (2xx) mutations get logged — not every read (too noisy to
    be useful as a change log rather than a request log), not failed
    validation errors, not blocked 403s (a genuinely different feature —
    a security event log — not "who changed what"), and not
    `recompute-health-score` specifically, since that's a derived
    computation triggered as a side effect of normal field work, not a
    change a human actually made. Passwords are redacted from any logged
    request body. Chose to join against `users` at read time for the
    email/name display rather than denormalizing it onto each log row —
    users are never hard-deleted (`is_active` soft-delete, see item 29),
    so the join always resolves, and it avoids the schema needing to
    reason about "what if the account changes."
    11 new tests, including one that explicitly accounts for a real design
    consequence rather than working around it: logging happens via a
    fire-and-forget insert after the response is already sent
    (`res.on("finish")`, needed because the final status code isn't known
    until the route handler completes), which means there's a genuine
    small window between "request completed" and "row visible in a
    subsequent query" — the test waits briefly and says why in a comment,
    rather than either ignoring the race or hiding that it exists.
    Because this change touched all 7 routers, the full pre-existing
    162-test suite was re-run specifically to catch any regression from
    a change this broad. Zero regressions. Full suite: **162/162 passing**.
    Dashboard: a new Audit Log page, gated to admin/facilities_manager by
    reusing the exact same role check already driving the dashboard's
    setup-button visibility — one flag, two consistent uses.
    Verified beyond the test suite: performed three real actions through
    the actual browser (create a property, a building, an opening), then
    confirmed the audit log page showed all three in the correct
    reverse-chronological order with the correct user attributed — and,
    the check that matters most, queried Postgres directly and found the
    exact typed opening code (`AUDIT-UI-TEST-001`) sitting inside the
    logged request body, not inferred from a screenshot.
32. ~~**Document storage**~~ — done. Fourth item on the list — warranty
    certificates, service contracts, insurance policies as real attached
    files, not just data fields. Reuses the exact presign → upload → confirm
    pattern already proven out for photos (migration `009_document_storage.sql`),
    extended to PDF/Word content types via a separate allowlist so the
    photo endpoint's content-type rules stay untouched.
    A document can attach to a property alone (a property-wide insurance
    policy has no single opening to hang off of) or to a specific opening
    (a warranty certificate for one door's hardware) — enforced by a CHECK
    constraint, and validated in the API before that constraint is ever hit,
    so a malformed request gets a clear 400 rather than an opaque Postgres
    error. No `organization_id` column on the table itself — tenant scope
    is derived by joining through whichever of `property_id`/`opening_id`
    is set, the same convention already used everywhere else in this
    schema, via a new `propertiesForOrgSubquery` helper added alongside the
    two that already existed.
    Because this touched all three cross-cutting systems built earlier in
    this list — `permissions.ts`, `auditLog.ts`, and `storage.ts` — each
    had to be deliberately extended rather than left to silently miss the
    new feature: technicians can upload/delete documents as real field work
    (same precedent as hardware), viewers can't, and every document
    mutation now shows up in the audit trail alongside everything else.
    13 new tests, full suite re-run for regressions given how many shared
    systems this touched: **175/175 passing**, zero regressions.
    Honest scope boundary, stated rather than silently worked around: there
    is no property detail page anywhere in this dashboard yet — only a
    creation form — so property-level documents are fully built and tested
    on the API, but the dashboard UI for browsing them only exists at the
    opening level in this pass, where the bulk of real usage would happen
    anyway. Building an entire new property page as a side effect of a
    document-storage request would have been real scope creep.
    Verified by seeding a document via the API (the same trust model the
    app itself uses — it never re-verifies a file against S3 either) and
    confirming in a real browser that the panel showed the exact title and
    working file link, and that clicking Delete correctly removed it and
    reverted the panel to its empty state. Along the way, an actual
    verification bug got caught and fixed: the first attempt navigated
    directly to a deep `/opening/:id` URL, which 404'd because the plain
    static file server this sandbox uses has no client-side-routing
    fallback — every other walkthrough in this project had correctly gone
    through the root page and clicked in-app links instead, and this one
    initially hadn't.
33. ~~**Work orders**~~ — done. Fifth item on the list, and the one named
    as highest-value from the start — the piece that closes the loop the
    alerts feature opened. An alert tells you something needs attention;
    a work order is where that turns into an assigned task with a due
    date and a status someone can actually update.
    Creating and assigning work stays admin/facilities_manager-only, same
    reasoning as creating openings or properties — planning work is a
    management decision. Updating a work order's status is different, and
    deliberately split into its own narrower endpoint
    (`POST /work-orders/:id/status`) that any field role can hit — but the
    route checks the work order is actually assigned to *that* user before
    allowing it, so a technician can mark their own job in progress without
    being able to touch, reassign, or reprioritize anyone else's.
    No DELETE endpoint, by design — same soft-delete caution as everywhere
    else in this project; a work order that's no longer needed becomes
    `status = 'cancelled'`, not gone, so the record of what was asked for
    isn't lost. `completed_at` is stamped automatically on `done` and
    cleared automatically if it's reopened.
    Caught a real TypeScript catch in my own code before it shipped: an
    always-true comparison in the `completed_at` logic that the compiler
    correctly flagged as redundant type-narrowing — simplified rather than
    suppressed.
    13 new tests, including the one that's actually the point of this
    feature: a technician gets a clean `403 not_assigned_to_you` trying to
    touch a colleague's work order. Full suite re-run given how many
    shared systems this touched: **188/188 passing**, zero regressions.
    Dashboard: a full Work Orders page — filterable list (open/urgent
    sorts first), a creation form with a real property → building →
    opening cascading picker and an assignee dropdown pulling actual team
    members, and a status control that's a genuine dropdown for
    management or the assignee and a plain read-only badge for everyone
    else.
    Verified end-to-end in a real browser, not just at the API level:
    created and assigned a work order as admin, then logged in as the
    actual invited technician and confirmed their status control was
    genuinely editable (not just visually similar to a disabled one) —
    used it to mark the job "In Progress" — then queried Postgres directly
    and found `status = in_progress`, `completed_at = NULL`, exactly
    matching what the browser showed, not inferred from a screenshot.
    Left as an open question at first — a dedicated field-app view versus
    dashboard-only — rather than assumed either way; built as the
    immediate follow-up once asked. See the next entry.
34. ~~**Field-app "My Work Orders" view**~~ — done, as the direct follow-up
    to work orders. A technician standing in a hallway with a phone isn't
    going to use the desktop dashboard — the field app is where this
    actually gets used day to day, so the open question from item 33 got
    resolved by building it.
    Found and fixed the same gap twice in one pass: neither the dashboard's
    nor the field app's JWT decoding had ever extracted `userId` from the
    token, even though the token has always carried it — only
    `organizationId` and `role` made it through. Fixed in both places
    (`decodeTokenPayload`, `AuthState`, and, for the field app, the
    IndexedDB-persisted session shape too, since offline sessions are
    stored locally) — worth noting because it's the second time this exact
    class of gap turned up (first in team management, item 29), which
    says something about how easy it is for a field to exist in a token
    payload without ever actually being plumbed through to where it's
    needed.
    New screen: a card per assigned job, priority shown as a colored left
    border (reusing the existing `card-health` pattern from elsewhere in
    the field app rather than inventing new styling), one big tap target
    per status ("Start Job" → "Mark Done"), tapping the card itself opens
    the full opening detail for context. Deliberately requires connectivity
    rather than queuing offline, same reasoning as hardware capture — a
    work order assignment isn't something a technician generates
    themselves, so there's nothing to usefully queue.
    Verified end-to-end on a real phone-sized viewport (390×844, not just
    resized desktop chrome): seeded a work order assigned to a real
    invited technician via the API, logged into the actual field app as
    that technician, confirmed the exact task title and an "Open" badge
    with a red urgent-priority border rendered correctly, tapped "Start
    Job," and confirmed both that the UI flipped to "In Progress" /
    "Mark Done" *and* that Postgres showed `status = in_progress` —
    the same two-layer confirmation (what the screen shows, what the
    database actually holds) used everywhere else in this project.
35. ~~**Inspector sign-off**~~ — done. Sixth item on the list — a captured
    signature is what gives the compliance report real weight, the digital
    equivalent of signing a paper inspection log.
    Built a real signature pad from scratch (`components/SignaturePad.tsx`)
    using raw canvas + pointer events — no new dependency pulled in for
    something this contained. Deliberately ink-on-white styling regardless
    of the field app's own dark theme, since a signature should read like
    ink on paper (and print cleanly on the compliance PDF), not match the
    surrounding UI.
    Nullable at the schema and API level on purpose (migration
    `011_inspector_signoff.sql`) — a dashboard-entered backfill of
    historical inspection data shouldn't be blocked by a DB constraint
    demanding a signature that never existed. The actual requirement lives
    at the UI layer instead: the field app's inspection form won't submit
    without both a drawn signature and a typed name.
    Surfaced in two places once captured, not just stored: the dashboard's
    Inspection History table now shows a "Signed By" column with an actual
    inline thumbnail of the signature, and the compliance report PDF notes
    "Signed off by [Name]" on any inspection that has one.
    4 new tests. Full suite: **192/192 passing**, zero regressions.
    Verified two ways, each proving something different. First, the part
    that actually matters — generated a real compliance PDF from a seeded
    signed inspection and extracted its real text, getting back exactly
    `"Last inspected 7/15/2026 (fire door nfpa80) · Signed off by Jordan
    Field Tech"`. Second, the harder check — rather than faking signature
    data through the API, used a real headless browser to *actually draw*
    a signature with simulated mouse movements on the live canvas,
    confirmed the form correctly blocked submission beforehand with "A
    signature is required," then confirmed after signing that Postgres
    held a genuine 15,414-byte captured PNG (not a trivial or empty one)
    with the exact typed name — and that the same new inspection then
    appeared correctly back on the opening's own detail screen after the
    app's redirect.
36. ~~**Recurring maintenance schedules**~~ — done. Seventh item on the
    list — "quarterly closer adjustments on this door" as a standing
    schedule, instead of remembering to create a work order every time.
    Real scope boundary, stated up front rather than discovered late: this
    app has no persistent background job scheduler — no cron process
    actually running anywhere, same honest category as the no-live-email
    and no-live-carrier-tracking calls made elsewhere in this project. Due
    schedules are checked and generated lazily, automatically, every time
    the work order list is loaded (`checkAndGenerateDueWorkOrders`,
    migration `012_maintenance_schedules.sql`) — plus a dedicated
    `POST /generate-due` endpoint a real production cron could call
    instead. Both paths call the exact same function, so they can never
    drift out of sync with each other. Each due schedule generates exactly
    ONE work order per check, then `next_due_date` advances in a loop
    until it's back in the future — deliberately not one work order per
    missed interval, so a schedule nobody checked on for six months
    catches up cleanly instead of dumping a backlog of stale duplicates
    into the list.
    **A genuine, reproducible bug was found and fixed during manual
    verification, not a theoretical one.** The first real-browser
    walkthrough showed a schedule's next due date jumping to 2029 instead
    of the expected three months out. Rather than shrug and rerun, traced
    it methodically: an isolated single call to the generation function
    worked perfectly; repeated *sequential* calls were correctly
    idempotent; but firing 5 genuinely *concurrent* calls at the same
    schedule (`Promise.all`, not sequential awaits) produced 5 duplicate
    work orders from one schedule — a real race, where two overlapping
    requests (say, a dashboard page load and someone clicking "Check Now"
    at the same moment) could both read the same "this is due" state
    before either had committed its advance. Fixed with a real
    transaction and `SELECT ... FOR UPDATE SKIP LOCKED` — a concurrent
    caller now skips a row another one is already processing rather than
    racing it. Re-ran the identical concurrent-call reproduction against
    the fix: `[0, 1, 0, 0, 0]` instead of `[1, 1, 1, 1, 1]` — exactly one
    caller wins the lock, the rest correctly do nothing. Added a dedicated
    regression test exercising this through real overlapping HTTP requests
    (not just the direct function call), specifically because the
    project's existing test-writing habits — sequential `await`s, one
    request at a time — were exactly what let this bug through
    undetected the first time.
    Worth also noting honestly: the *second* time the browser walkthrough
    still showed a wrong date, it looked at first like the same bug
    recurring — it wasn't. It traced to the test script itself (a flaky
    triple-click that appended "3" onto an existing "3" instead of
    replacing it, silently submitting `interval_count: 33`), not the
    application. Confirmed by checking the actual stored value directly
    rather than assuming, fixed the test script's input handling, and
    reran clean. Both the real bug and the false alarm are recorded here
    for the same reason: this project's verification has consistently
    meant checking what actually happened, including checking your own
    checks, not just re-running something until it looks right.
    12 tests (11 covering creation, pause/resume, tenant isolation, and
    the core catch-up-without-spamming logic, plus the dedicated
    concurrency regression). Full suite: **204/204 passing**, zero
    regressions.
    Dashboard: a full Maintenance Schedules page — list, a creation form
    with the same property → building → opening cascading picker used
    elsewhere, pause/resume, and a manual "Check Now" button for triggering
    generation on demand rather than waiting for a page load to do it
    implicitly.
    Verified end-to-end with the corrected browser walkthrough: created a
    schedule due today through the real UI, clicked "Check Now," and
    confirmed both the on-screen result ("Generated 1 work order," next
    due date correctly advanced to exactly three months out) and the
    Work Orders page showing the real generated task — cross-checked
    against Postgres throughout, not inferred from screenshots alone.

## Design notes worth keeping in mind

- `qr_token` is separate from `opening_code` on purpose — you can relabel or
  reorganize an opening's human-readable code without needing to reprint
  and re-tag the physical QR.
- `health_score_history` is append-only with a `factors` JSONB column so you
  can always explain *why* a score changed — this matters both for customer
  trust and for eventually training a smarter model on top of this data.
- Multi-tenancy (`organizations`) is in the schema from day one even though
  your pilot only has 3-5 customers — retrofitting tenant isolation later is
  much more painful than building it in now.
