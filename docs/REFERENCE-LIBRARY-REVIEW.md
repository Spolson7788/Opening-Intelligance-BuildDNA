# Reference library: review (DRAFT, nothing applied)

Branch `reference-library` from `aa292d5`. Decision (Oct 29, 2:57 PM MST): the library lives in app staging
`boaoedvyvifppuklbwad`; recognition reads it locally. Chat keeps uploading drafts into `ioqfdcehnhnqpnqawwvo`;
a later, separately approved one-time copy moves them over. **No migration was applied, nothing was written
to any staging database, nothing was uploaded or deployed.** `fadihkhdwpfffpelqjtg` and production were not used.

## What is in the branch
| File | Purpose |
|---|---|
| `migrations/20261030091000_reference_library.sql` | DRAFT. 13 tables, triggers, staff functions, RLS/revokes, recognition_runs columns |
| `docs/rollback/20261030091000_reference_library_rollback.sql` | Undo; refuses once any release exists |
| `src/services/referenceImport.ts` | CSV parsing, import planning, draft-only apply, sha256-deduped copy, local-only guards |
| `scripts/reference-import.ts` | CLI. Dry-run by default; `--apply` only to localhost; `--copy-from` for the later one-time copy |
| `src/services/referenceRetrieval.ts` | Active-release-only context + citation validation |
| `src/routes/recognitionRuns.ts`, `src/services/legacyVision.ts` | Recognition wiring |
| `tests/referenceLibrary.test.ts`, `tests/recognitionReferenceCitations.test.ts`, `tests/fixtures/reference/*` | New tests (added to `vitest.offline.config.ts`) |

## Schema
* Ported from ioqfd (same columns): `reference_documents`, `reference_document_models`, `reference_pages`, `reference_conflicts`.
* Added to documents: `revision`, `source_origin`, `received_on`, `licence_storage` / `licence_ai_processing` /
  `licence_customer_display` (unknown/permitted/restricted/denied), `licence_note`, `interim_only`, `imported_from`.
  An approved document must have storage **and** AI processing permitted and must not be interim. Storage keys
  cannot be URLs or `public/` paths. Approved document content cannot be edited or deleted.
* `reference_products` (+ `reference_product_sources` page links), `reference_dimensions` (value, units,
  normalized_mm, endpoint_a/b, orientation, configuration, tolerance, source doc + page, dimension_source, claim_tier,
  verification_status unverified/manufacturer_stated/verified/rejected; *verified requires every field*).
* Look-alikes: `reference_lookalike_groups` / `_members` / `_pairs`, seeded from the Von Duprin hard-negative files.
* `reference_assets` (image package manifests, checksums, interim flag).
* `reference_releases` + `reference_release_items`: versioned immutable snapshots, exactly one active
  (partial unique index), content sha256. Items can never change; a release may only go active -> retired.
* Approval: `reference_approve(actor, org, kind, key, reason)` for document/product/dimension/lookalike_group and
  `reference_release_publish(actor, org, reason)`. SECURITY DEFINER, active OI staff only, reason required,
  `platform_audit_events` row in the same transaction (4 new actions + `reference_release_published`).
* Privacy: RLS on all 13 tables; ALL revoked from PUBLIC, anon, authenticated; `oi_pr2_api` SELECT only plus
  EXECUTE on the two functions. No bucket is created here; documents stay in the private bucket.
* `recognition_runs` gains `reference_release_id` (FK) and `reference_citations` jsonb `{cited, rejected}`.

## Recognition
* Candidates come only from the **active release** items (never draft tables). The opening's recorded hardware
  (manufacturer, model) ranks matching products first; then their verified dimensions, cited pages and approved
  look-alike groups; capped at 60 facts / 12,000 characters.
* Facts are numbered `R1..Rn` and appended to the identify prompt only when a release exists. The model is told the
  facts are background, not evidence, and to list supporting ids in `reference_citations`.
* The run records `reference_release_id`; citations are validated against exactly the ids sent; anything else
  (invented, duplicated, non-string) is stored under `rejected`. `processing_config` records
  `reference_context_version`, release version and fact count.
* No release (or the migration not applied): the request is byte-identical to today, nothing is cited.

## Dry-run import on a throwaway PGlite (real PC manifests, all migrations applied in memory)
| | rows |
|---|---|
| Registry v17 products (2,442 rows; 12 duplicate manufacturer+series+model collapsed) | 2,430 |
| Draft Von Duprin products created for dimension manifest items not in the registry | 25 |
| **Products total (all draft)** | **2,455** |
| Assets: VD combined manifest (with sha256) | 656 |
| Assets: LCN Part A (interim_only) | 1,048 |
| Dimensions (VD manifest; all `manufacturer_stated`, **0 with a value**) | 329 |
| Look-alike groups / pairs / members | 3 / 462 / 0 (22 members unassigned) |
| Documents / pages / models | 0 (these come from the ioqfd copy) |
Re-running the import inserts 0 rows. Nothing is approved, nothing is verified.

## Open questions
1. **VD dimension manifest has no numbers.** It records which images are dimensioned, claim tier and status,
   not values. Values must be transcribed from the source pages before any dimension can be verified.
2. **Set members have no set id.** `hn_CF__SET_MEMBERS.csv` lists 22 members without `comparison_set_id`; with 3
   sets they are left unassigned rather than guessed. Need the mapping (or the source file that has it).
3. **Prompt version.** The identify prompt changes only when a release exists; `prompt_version` is unchanged and
   the reference block is versioned separately (`reference-context-v1` + release version). Bump prompt_version instead?
4. **Ranking** is simple hint matching on the opening's hardware records; no full-text search over pages yet.
5. **Who sets licences** (storage / AI / customer display) per document, and on what evidence. All import as unknown,
   so nothing can be approved until someone sets them.
6. **The ioqfd -> boaoed copy** (`scripts/reference-import.ts --copy-from`) needs its own approval and, because the CLI only writes
   to localhost, a reviewed path for the staging target. Storage objects are not copied by this script.
7. LCN Part A is interim-only and can never be approved in this schema; confirm that is intended until Part B.
8. Applying `20261030091000` to boaoed is a separate approval.
