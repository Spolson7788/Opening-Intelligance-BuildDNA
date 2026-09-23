# Dashboard display corrections — 2026-09-23

Separate nonproduction preview only. Production and frozen R8 are unchanged. No database migration or dataset reset is required.

## Changes

- Opening detail headers no longer inherit the fixed thumbnail width/height. Titles and conditions wrap independently.
- Corrective totals count only intended replacements without completed work. Serviceable/refused components do not inflate the priced replacement count. Missing estimates remain explicit.
- Recorded service this quarter totals facility-scoped service events; it does not substitute component estimates or count components as events. Failed reads report unavailable. Missing costs do not become recorded zero dollars.
- Date-only component service dates retain their calendar day regardless of viewer time zone.
- Photo captions identify opening/frame/leaf/component scope. Component captions include parent leaf and manufacturer/model, differentiating repeated products.
- Dashboard image section says Attached images because demonstration attachments can include reference images and renders.
- Late signed-photo responses cannot append to a newly selected opening's detail panel.

## Verification

10 Node tests PASS: financial rules, paginated service reads, failed requests, stale facility responses, calendar dates across Phoenix/Los Angeles/UTC/Kiritimati and invalid dates. Six additional direct assertions PASS for paired component photo captions, structure/opening captions and missing component fallback. Generated Dashboard and editor JavaScript syntax checks PASS. Build and diff whitespace checks PASS.

New Chromium visual and connected deployment checks have NOT run for this correction candidate. Previous browser-results.json describes the earlier mocked baseline; it is not new evidence for this patch. No live acceptance verdict is implied by local tests.

## Expected synthetic dataset display after deployment

STG-DASH-R1: corrective work $250, one replacement priced and one awaiting estimate; recorded service this quarter $85 and one service event. The 102-HEALTHY component service date remains September 21, 2026, including in Arizona. Detail titles must not overlap metadata at desktop or phone widths. Five scoped attachments remain distinct under 101-PAIR.

## Release boundaries

Keep the protected preview and synthetic-data notices. The manual opening editor is not the original recognition Field Identifier. Image attachments do not establish physical product identity or compatibility. Purchasing remains review-only. Preserve existing immutable deployment evidence. HOLD remains until connected checks and visual verification are complete on the recording candidate.
