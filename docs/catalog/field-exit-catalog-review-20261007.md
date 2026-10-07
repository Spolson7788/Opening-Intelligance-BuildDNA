# Field exit-device catalog integration — 7 October 2026

Goal: recognize the highest defensible manufacturer, series and exact model from grouped field views, retain evidence and conflicts, and score technician-confirmed outcomes.

## Reviewed scope

- Existing six PDQ 6200 rim designations remain unchanged. Legacy status is retained; discontinuance is not claimed as confirmed.
- Added 145 exact-model identity rows: 21 PDQ current exit designations; 16 Von Duprin 33A/35A designations; 108 Yale/Accentra rows (54 designations under each readable brand name).
- Twelve explicit family rows: Von Duprin 33A/35A; Yale and Accentra 1500, 1800, 2100, 6000 and 7000.
- These are bounded identity catalogs. The entire manufacturer library is not imported into paid reference comparison; dimensions, trim, functions and product images remain outside this reviewed slice.

Yale Commercial/Accentra history is documented by https://www.assaabloy.com/us/en/about-us. Retain the brand actually read on installed hardware. A catalog relation is not independent confirmation that the reader transcribed the photo correctly.

The supplied VonDuprin.zip was retrieved, and relevant source PDFs were read directly. Five Accentra exit catalogs were extracted from archive parts 21, 22 and 24. Their bytes match the intake SHA-256 values. Source URL, PDF page and hash accompany each imported row.

The freshly fetched official 2026 PDQ price book differs from the supplied extract's source hash. Every imported PDQ designation was independently checked against its cited page in the fresh PDF. Both hashes are recorded; the submitted hash is not misrepresented as the current file hash. Cross-reference/trim relations never establish identity.

## Evidence handling

Literal complete maker and same-photo series markings can return a partial identity without an exact model. Reader identity claims and part-number prefixes cannot establish the series. A standalone series marking cannot establish a rim/rod/mortise configuration, even where a designation also names a model. Type and maker conflicts remain explicit. The reader's photo-set concerns are retained for review.

Saved-evidence review is actor/opening scoped and read-only. It makes zero AI calls and does not create a run or overwrite the original suggestion. Its source and review builds are shown, and its derived result cannot be submitted as if the frozen run produced it.

## Verification

- 260 recognition tests across 21 files passed.
- 41 budget/history tests across two files passed.
- TypeScript and Field App build passed.
- 220 unselected source/test/config files matched deployed parent 18e940ac48e9284c2791d31e40142471208b48a2.
- Real saved evidence from run d71806fe-3cc2-431e-b648-d51e1afd2f4e replayed locally: Von Duprin / 35A / exact model null, with maker and series evidence from Photo 3 and all three reader concerns retained. No paid call; this is processing verification, not a fresh field score.

## Next field test

Select all five previously supplied Yale images. The client orders filenames consistently; the frozen manifest is docs/engineering/yale-baseline-scope.json. No expected identity is supplied to the model. The next original-byte set receives one test allowance after protected-preview deployment verification, retaining the cumulative $5 cap and all previous reservations. Technician truth is still required for scoring; no general accuracy claim follows from these few devices.
