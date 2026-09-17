# Paired-Opening Data Contract

## Assessed baseline

- Repository: `Spolson7788/Opening-Intelligance-BuildDNA`
- Baseline commit: `03cc8a83e238c191d8381e634c6c4951b12a072c`
- Development branch: `feat/paired-opening-data-model`
- Database target used for migration/testing: disposable local PGlite/PostgreSQL-compatible database only
- No production or remote migration was executed.

## Canonical hierarchy

`organization → portfolio → property → building → opening → frame + door leaves → hardware components → photos/events`

- `openings` owns opening-wide identity, configuration, and persistent completion.
- `opening_frames` is one-to-one with an opening.
- `door_leaves` is one-to-many with an opening, constrained to one row per physical role (`single`, `active`, `inactive`).
- `hardware_components.id` remains the permanent component identity. Components may be mounted to the opening, its frame, or one door leaf. Same-class components are independent rows.
- `photos` retains the opening foreign key and may additionally target a frame, leaf, or hardware component.

## Compatibility and migration

Migration `013_paired_opening_model.sql` is additive. Existing openings default to `single` and `draft`. Existing hardware defaults to opening-scoped, unresolved, unverified, and pending review. Existing rows are not assigned to a leaf because that physical relationship cannot be inferred safely.

Legacy records require technician review before completion. No source record is deleted or rewritten by the forward migration.

The explicit destructive rollback is documented in `docs/rollback/013_paired_opening_model_rollback.sql`. Export new hierarchy data before using it; paired-opening information cannot fit the legacy schema.

## Completion and purchasing

Completion is stored on the opening and requires:

- a frame;
- a `single` leaf, or both `active` and `inactive` leaves for a pair;
- at least one hardware component; and
- all hardware components reviewed.

Purchasing eligibility is evaluated per physical component and requires the entire opening to be complete, the component to be reviewed, product identity to be established, condition to be `worn` or `failed`, and replacement to be required. Consequently an unresolved worn closer remains blocked and serviceable hardware remains excluded.

## Retry and tenant isolation

Component and photo creates accept client operation UUIDs. Partial/offline retries using the same operation UUID return the existing row instead of duplicating it. Every hierarchy mutation validates the opening through the caller's organization before writing, and every leaf/frame/component photo association is verified against the same opening.

## Known repository gap

The committed Dashboard imports numerous page modules that are absent from Git, and `dashboard/tsconfig.json` is also absent. An older repository ZIP contains candidates, but they were not restored because their provenance relative to the current commit is not established. API hydration now returns the new hierarchy, and Dashboard API types include the new opening fields; completing and testing the Dashboard presentation requires the authoritative missing source.
