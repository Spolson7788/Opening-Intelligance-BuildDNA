# Opening Intelligence — ChatGPT Business Migration Backup

**Snapshot date:** 2026-09-09  
**Repository:** `BuildDNA/opening-intel`  
**Purpose:** Durable repository-side continuity record created before the ChatGPT Personal → Business workspace migration. This file is a backup handoff only. It does not authorize manufacturer execution, remediation, imagery generation, schema changes, or deletion of historical work.

## Authoritative repository state

- Default branch: `main`
- Main snapshot commit at backup start: `2404b8100e096e2b3d85672f7f82d982b8c92067`
- Master coordination branch: `oi-canonical-imagery`
- Master coordination branch head observed at backup: `653a3bd7d0978e1ebfcfa256ca66daf891e0e9c5`
- Codex technical-audit branch: `codex/conduct-comprehensive-technical-audit`
- Codex audit head: `e9e82d477a7b73d2f7814165cb619e07ec5bccb7`
- Codex audit PR: `#13`, OPEN and UNMERGED at backup time.

## Non-negotiable current execution control

Preserve:

`UNATTENDED_IMAGE_GENERATION_ENABLED = FALSE`

`UNATTENDED_IMAGE_QA_EXECUTION_ENABLED = FALSE`

`UNATTENDED_IMAGE_REQUEST_ADVANCEMENT = PROHIBITED`

Do not generate images, retry imagery, advance image requests, or interpret historical imagery-ready state as current authorization. Existing imagery, evidence, hashes, manifests, holds, and indexes remain preserved.

## Current unattended scheduler

The rate-limit hardening merged to `main` at:

`2404b8100e096e2b3d85672f7f82d982b8c92067`

Preserve these runtime controls:

- cadence: every 15 minutes
- maximum selected lanes per cycle: 2
- maximum parallel model lanes: 2
- second model-lane start stagger: 90 seconds
- transient model-failure cooldown: 90 seconds
- target model execution slice: 10 minutes
- fair rotating lane selection: enabled
- external-dependency lanes sleep rather than consuming recurring capacity
- token/output hardening: narrow command output; do not dump entire PDFs, raw binary/base64, huge JSON/logs, or irrelevant object streams into model context
- unattended imagery: disabled

## Manufacturer ownership and lane state

Preserve manufacturer boundaries. One manufacturer's sources, measurements, geometry, identity mappings, CAD/BIM, or configuration assumptions must never establish another manufacturer's product facts.

Current governed branches observed at backup include:

- `oi-004-calroyal-evidence`
- `oi-026-falcon-evidence`
- `oi-036-pamex-evidence`
- `oi-assa-abloy-evidence`
- `oi-canonical-imagery`
- `oi-corbin-russwin-evidence`
- `oi-dormakaba-evidence`
- `oi-glynn-johnson-evidence`
- `oi-hager-evidence`
- `oi-ives-evidence`
- `oi-pdq-evidence`
- `oi-sargent-evidence`
- `oi-schlage-evidence`
- historical engineering/scheduler branches remain preserved

### Allegion child-lane migration is NOT complete

At backup time, `oi-orchestration/UNATTENDED_LANES.json` still registers only the following Allegion children:

- Falcon
- Ives
- Glynn-Johnson

Those entries still use the broad `AUTHORIZED_MANUFACTURER_GROUP = ALLEGION` and `EXECUTION_OWNER = ALLEGION_LANE` pattern.

Schlage, Von Duprin, and LCN are not yet fully represented as six independently owned unattended child lanes in the scheduler registry. Do not mark the Allegion child-lane migration complete until all six child lanes are correctly owned, non-overlapping, registered, synchronized with Master Grok, and operational or validly dormant.

Historical complete governed Allegion authority to preserve:

- Ives: 248 identities
- Falcon: 27 identities
- Glynn-Johnson: 9 identities
- LCN: 43 identities
- Schlage: 112 identities
- Von Duprin: 69 identities
- total: 508 identities

The Allegion parent is intended to be coordination-only after the split.

## Evidence and measurement governance

Preserve evidence classes and semantic separation, including:

- `MANUFACTURER_STATED`
- `GEOMETRY_VERIFIED`
- `PHYSICAL_MEASURED`
- `DERIVED_CALCULATION`

Representative identity/disposition states include:

- `STATED_DIMENSIONS_COMPLETE`
- `STATED_DIMENSIONS_PARTIAL`
- `SOURCE_MAPPING_UNRESOLVED`
- `SOURCE_CONFLICT`
- `NOT_PUBLISHED`
- controlled holds where applicable

Never infer manufacturer dimensions from pixels, generated imagery, neighboring models, adjacent catalog rows, or cross-manufacturer similarity. Published measurements require exact provenance and semantic mapping. Physical measurements require a unique physical sample identity and published method/uncertainty before serving as a discriminator.

## Canonical registry rule

The canonical product registry remains conceptually distinct from installed hardware instances. `hardware_components` represents installed hardware instances and must not be repurposed as the canonical product registry. Canonical identity requires manufacturer/model/part number, family/type, configuration axes, status, and provenance appropriate to the governed architecture.

## Codex technical audit handoff

PR #13 contains six documentation-only audit files:

- `docs/audits/OPENING_INTELLIGENCE_TECHNICAL_AUDIT.md`
- `docs/audits/OPENING_INTELLIGENCE_SECURITY_AUDIT.md`
- `docs/audits/OPENING_INTELLIGENCE_ARCHITECTURE_MAP.md`
- `docs/audits/OPENING_INTELLIGENCE_RISK_REGISTER.md`
- `docs/audits/OPENING_INTELLIGENCE_REMEDIATION_PLAN.md`
- `docs/audits/README.md`

Audit snapshot:

- 0 CRITICAL findings
- 10 HIGH findings
- 17 MEDIUM findings
- 1 LOW finding
- production disposition: NO-GO for customer production deployment at audit time
- controlled internal pilot only after required blockers are closed and verified
- major high-risk themes include object-storage authorization/deletion, tenant/provider authorization, session/device security, idempotency/offline sync, and the absence of application-level canonical identity, measurement/provenance, and recognition-verification domains

Do not tell Codex to “fix everything.” Audit findings must be triaged and remediated in a controlled order. Preserve working boundaries and avoid unnecessary rewrites.

## Known manufacturer continuity notes

These are continuity notes, not permission to invent work:

- Cal-Royal: preserve current evidence, reconciliation, measurement, hold, and historical imagery state. Measurement reconciliation remains a major non-imagery lane.
- ASSA ABLOY parent: preserve paused child-lane migration / umbrella coordination role.
- SARGENT: child-lane ownership remains SARGENT-specific and non-imagery work can continue when checkpoint state is executable.
- Corbin Russwin: preserve external-manufacturer-dependency state when no authorized native source route is executable.
- PDQ: preserve active non-imagery evidence/bootstrap architecture and manufacturer-only boundary.
- Hager: unattended execution may perform only authorized non-imagery measurement/source/identity/CAD/BIM/geometry/catalog/template/drawing/evidence work. Historical interactive imagery activity does not override the current no-image directive.
- Dormakaba: preserve evidence-lane work and exact-package-manifest gate; do not regenerate imagery merely to create progress.
- Pamex: preserve manufacturer-response dependencies and controlled geometry/imagery holds.

## Durable persistence expectations

For non-imagery unattended work, preserve the existing write-boundary and compare-before-push model. Meaningful authorized work should update deterministic checkpoint/resume state and persist within the owning manufacturer's allowed workstream root.

Historical canonical imagery completion logic remains evidence of prior architecture only while generation is disabled. `GENERATED` never by itself equals `COMPLETE`.

## Business migration recovery rule

If ChatGPT chat history, memory, plugin state, or custom instructions are incomplete after migration, use this repository and the manufacturer branch checkpoints as the authoritative Opening Intelligence recovery source. Do not reconstruct product facts from chat recollection when repository evidence exists.

Before resuming any lane after migration:

1. read current `main`
2. read the current master handoff on `oi-canonical-imagery`
3. read the exact manufacturer branch checkpoint
4. verify current scheduler registry ownership
5. preserve the no-image directive
6. continue from the exact first unfinished authorized non-imagery task
7. do not repeat already-persisted work

---

This snapshot intentionally records continuity and controls. The live repository remains authoritative for later changes after this date.