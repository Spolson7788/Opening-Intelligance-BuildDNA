# Connected media display repair — local review

Base: a970d244f0ee27cff3c35fbbe2a063a83e5db624, the immutable connected candidate 6ac02acb9cb4f40008161d0a. This patch is not deployed.

## Behavior

- Field image/video loading errors and unavailable access responses display an honest unavailable state. Attachment records and component labels remain present.
- Facility Dashboard keeps labeled unavailable-photo figures instead of removing failed images and hiding the section. Results from a previously opened detail cannot attach to a new opening.
- Component rows and details show the latest valid matching component service event's calendar date. Opening-level events, sibling events, creation/verification timestamps and invalid dates do not supply that date. Work completion remains separate; service does not remove a still-needed replacement from corrective totals.
- Event-count summaries say service events, not visits. This does not infer distinct attendance or completed repairs.

## Validation

Install the root and field-app lockfiles with npm ci. Run npm run test:connected-media from root (offline DOM tests; no browser profile/database/network). Run node node_modules/vitest/vitest.mjs run --config vitest.offline.config.ts tests/serviceHistoryModel.test.ts. Run npm run build in field-app. Do not use the default integration test configuration against a hosted database.

The new regressions exercise actual Field SyncedMedia via ReactDOM and generated Dashboard photo code using jsdom: all-nine failures, denied/missing access URLs, image/video errors, healthy/failed coexistence, stale callbacks, valid per-component event dates, retained corrective cost, and event wording. They do not prove hosted media availability or browser recovery behavior.

## Missing original evidence and repair boundary

Nine existing synthetic paired-opening photo rows remain marked historically verified, while the observed destination ioqfdcehnhnqpnqawwvo / oi-opening-media-pr2-private has no storage.objects metadata at any of their nine keys or exact filenames. All nine records name OP1_closer_whole.jpg, 23282 bytes, SHA-256 23d95b0541cefaeb040fedc028eb2227d72b0038904fe8ec1d8526d5d4c00efb. An identical expected hash is not a recovered original. No matching file was returned by bounded checks of the current task and the prior October 16 task-2 artifacts; some recursive paths were unreadable, so this is not an exhaustive backup search.

Eight keys use synthetic Provider A's org prefix; the September 27 photo uses the older organization prefix. No migration/copy/cleanup record or authoritative intended storage binding was found in reviewed source/reports. Neither loss nor wrong configuration has been established. Do not rewrite these keys or substitute stock/generated media.

Before any storage repair, identify an authorized original/backup with the exact expected byte count and hash, confirm the intended project/bucket from authoritative provisioning evidence, then present the exact nine destination keys and per-object metadata to restore for approval. Preserve photo IDs and component associations. If originals cannot be recovered, retain explicit unavailable evidence rather than fabricate it. Validate byte retrieval/hash and rendering after any separately approved repair.

## Deployment boundary

Proposed deployment target only: Netlify stephan-o / oi-connected-release-candidate, site 80fbbee8-b9d3-4b16-b93f-d2d8396591ec. Current database binding fdudsigbxumcpbxxxerb. Do not deploy this to oi-thrive-schedule-staging or the newer recognition preview branches. Expected impact: Field and Facility Dashboard presentation only; no migrations, permissions, credentials, storage writes, new photo records or API data mutations. A new reviewed build/immutable deployment and explicit publication approval are required; no existing deploy is modified by this local patch.

Photo availability remains a release blocker. Paired component-history display was independently observed in both Field and connected Facility Dashboard. Isolation, revocation, multi-facility filters/default changes, mutation propagation and offline/interruption/recovery acceptance remain unfinished. The local display fix does not close those items.
