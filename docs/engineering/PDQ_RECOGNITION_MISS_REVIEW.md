# PDQ grouped-photo recognition miss — 2026-10-07

Goal: correctly name installed hardware from grouped field photos and measurably improve against technician-acknowledged truth. Human-reported identity is PDQ / 6200 / 6200R rim exit. Formal run-linked technician acknowledgment remains pending.

## Actual field result

Build 66c3f9fc2c8efa4ecf6a3747f13939dcc0608062 completed its recognition response in 44.258 seconds. Locator, both readers and classifier returned stored replies. No timeout was reported in this run. The reader transcribed the cast logo as DORMA, returned no model text, and the classifier returned DOOR_CLOSER with DORMA and invented hydraulic-body/arm observations. Final manufacturer, series and model were null; component type was closer. All four identity/class fields fail against the human-reported PDQ exit-device identity. This is one development device, not an aggregate accuracy estimate.

The locator repeated the prior misplaced normalized coordinates. Label photo index 2: x .35, y .55, w .25, h .15. Maker photo index 1: x .15, y .35, w .25, h .25. The model reader explicitly said the source photograph contains a label that the crop misses. Parallel timing and context did not deliver correct recognition. Catalog rejection prevented an unsupported identity but does not count as identification success.

## Free investigation and next evidence

Verify the exact private originals and outgoing views visually before authorizing another recognition run. Checksums establish byte continuity, not whether a crop contains a label. The free saved-originals check now displays the actual private originals, in the same ordered set, using existing authenticated, opening-scoped photo access. No reader call is made to show them. The supplied chat copies clearly show PDQ and Model 6200R; they are lower-resolution copies, not byte-identical to private camera originals.

Local whole-frame Tesseract on the chat copies at four rotations did not read either identity reliably. A separate manually selected label crop, rotated 270 degrees, returned the exact model token 6200R through Tesseract; neighboring text included a misread Aodel heading. The manual logo crop still did not read PDQ reliably. This isolates a useful label-reading path, but is not automatic localization or an OI field pass. Any manually annotated crop experiment must be reported separately from automatic localization and must never inject product-specific coordinates into the production locator.

## Grok review request

Independently review the stored raw replies, exact source/context/crop images and transformations, and the photo-index/orientation associations. Determine whether the errors arise from crop location, wrong or altered image content, reader hallucination, or multiple causes. Check the classifier's physical descriptions against actual pixels. Do not propose another paid rerun until the exact reader inputs have been inspected. Do not overwrite old runs, substitute human-known identity into a model result, or call this correction recognition progress. No production deployment or automatic learning/example admission is authorized by this note.
