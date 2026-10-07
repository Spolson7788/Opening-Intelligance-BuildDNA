# PDQ exit-device catalog extract (for Opening Intelligence)

## Purpose
OI identifies door hardware (brand / series / model) from field photos. A frozen baseline run misread a
**PDQ 6200R** rim exit device (cast PDQ logo on end cap, UL sticker "Model 6200R") as "DORMA". Planned fix:
a cast-logo brand read stands only if the brand+model pair exists in a reference catalog. That catalog is
Allegion-only today. This extract adds PDQ exit devices. These are data files only. Chat loads them into OI
through a reviewed PR. No repo, DB or OI changes were made.

Note: PDQ's own Quick Cross Reference Guide lists **Dorma 9300 as the equivalent of the PDQ 6300R**, and the
DK1 trim fits Dorma 9300 devices. A PDQ/Dorma mix-up is therefore plausible, but these are cross-references, not
identity evidence.

## How it was built
- Source: `/workspace/pdq_docs` (official pdqlocks.com PDFs, pdftotext `.txt`, `index.csv`). Every row's
  `source_url` and `source_sha256` come from `index.csv`.
- I searched all 410 `.txt` files for exit series numbers (6x00, 4x00/5x00/7x00/9x00). Exit-device series
  in the library: **4200, 6300, 6400**, plus **6200** as a "previous generation" mention only. 5100/5300/5500/7100/3100
  are door closers. 9300 is a PDQ mullion. 4500/4600/4700 hits are Hager models.
- `build.py` (included) builds both CSVs. It finds every quote in the source text (whitespace-normalized,
  otherwise verbatim) and stops if any quote is missing. `page` is the PDF page, worked out from form feeds in the
  pdftotext output.
- Current models are cited to the 2026 Price Book line for each model.

## Counts
- `pdq_exit_models.csv`: 22 rows. 6300: R, RF, V, VF, C, CF, M, MF, D (9). 6400: R, RF, V, VF, C, CF (6).
  4200: R, RA, RF, V, VA, VF (6). 6200: 1 row (discontinued).
- `pdq_relations.csv`: 126 rows. 8 trim/look-alike/supersession rows, plus Quick Cross Reference Guide rows
  (6300: 56, 6400: 40, 4200: 22 = 118).

## Rules for OI
1. A PDQ brand+model read passes only if that exact pair is in `pdq_exit_models.csv`.
2. Relations (`pdq_relations.csv`, all `identity_evidence=no`) never establish identity. A cross-reference
   (e.g. PDQ 6300R ≈ Dorma 9300) must never turn a PDQ read into a Dorma answer, or the other way round.
3. Discontinued models (6200) are valid answers for installed hardware.

## Gaps and ambiguities (decide these; don't guess)
- **No 6200 or 6200R spec sheet, template, instructions or image exists in the library.** The string "6200R"
  appears nowhere. "6200" appears only as: "previous generation 6200 devices", "Head Cover (Similar to 6200
  Series)", HG1 "PDQ 6200 series" and the 6S not-compatible note.
- The 6200 row says `discontinued` because PDQ calls it the "previous generation" and it has no price or spec
  entry. The word "discontinued" never appears. The row is at series level (`model=6200`). If OI must match
  `PDQ + 6200R`, Chat must decide whether to add a 6200R row based on the field UL label. PDQ's R=rim naming
  (6300R/6400R/4200R) suggests it, but the library does not document it.
- **Identifying markings are not documented** for any model: nothing on cast logos, end-cap branding or UL
  label text. The `identifying_markings` column holds only the documented model designation and UL listing
  type (UL305 panic / UL10C fire).
- No 6400M/6400MF or 6400D appears in the 6400 cross-reference or price list. These rows are not included.
- Variants left out as models: LBR (less bottom rod) options, delayed egress, windstorm/HVHZ versions,
  4200RFA/VFA (seen only in template file names, no price-book line).
- Quick Cross Reference Guide oddities, transcribed as printed: Hager 6300MF column reads "4500 MRT" (the price
  book version says "4500 MOR FR"). Sargent 6400V/VF are "N/A" and skipped. In the 4200 table the column order is
  CAL ROYAL, CORBIN/RUSSWIN, DORMA, FALCON, HAGER, PRECISION, SARGENT, S PARKER, TELL, VON DUPRIN, ACCENTRA, mapped
  in that order. Check the "S PARKER"/"TELL" assignment against the PDF (page 10 printed).
- The guide includes a disclaimer: "PDQ makes no guarantees as to their accuracy".
