# PDQ extract review — 2026-10-07

Goal: scored brand/series/model recognition from grouped field photos and technician-confirmed learning. This change supplies candidate facts, not a measured gain or confirmed example.

Submitted archive contains 22 model rows, 126 relations and a generator. It contains no source PDFs or source text/index required by the generator; it cannot be reproduced from the archive alone. Preserve submissions unchanged for review, not automatic import/approval.

Corrections:
- No literal 6200R entry in the submitted extract. Independently retrieved PDQ official architectural submittal lists 6200R, 6201R, 6200RF, 6200RA, 6201RA, 6200RFA on PDF page 2. Six exact catalog designations admitted to candidate vocabulary. Source URL is recorded in src/services/pdqCatalog.json. PDF binary retrieval returned 502; hash is explicitly null. Text retrieval establishes designations; visual layout was not verified.
- Lifecycle is legacy; discontinued is not manufacturer-confirmed. Previous generation and absence from a current price list do not independently establish discontinued status.
- Submitted relation `6300 replaces 6200` is not established by its quote about matching previous-generation appearance. Quarantine this relation.
- All trim fits, look-alikes and cross-references are excluded from identity matching. 4200 table mapping remains unverified.
- The 2026 price book exceeds web retrieval size limits. Its 21 current model rows and claimed PDF hash remain submitted, unverified facts; not active catalog entries.

Runtime review groups maker marks and model readings within the same submitted device set and preserves photo indices. It returns catalog-supported candidates pending technician acknowledgment, conflict when a readable maker differs from the supported maker, or insufficient evidence. A classifier guess is recorded separately; it is not a readable logo. An unsupported tuple means absent from this limited catalog, not historically impossible.

Baseline run 92052f1f-794b-42e8-b33d-462394c29126 remains unchanged. Paid rerun paused pending actual provider-cost reconciliation. Original transport, UI/export presentation and technician scoring/miss queue remain open. No training or recognition-accuracy claim follows from this import.
