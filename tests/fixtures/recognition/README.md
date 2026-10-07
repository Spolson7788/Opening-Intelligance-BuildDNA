# Installed 3 — development regression fixture only

SHA-256: 4f46d88ad71d97bb9aff870efa56eccc82de8b17aafa8b381994e86c969b668f
Source: 438 × 238 pixels. Locator boxes vary; the observed 97 × 144 label crop
was padded from source pixels, and its proposed model-line height was about
19–20 pixels. Upscaling does not recover missing characters. This is no longer
an accuracy or held-out evaluation image and must not guide product-specific
crop coordinates or expected text in prompts.

Mocked expected outcome: DOOR_CLOSER; surface, regular arm, standard arm, no
cover; manufacturer/model null; label legibility partial or illegible; no exact
model promoted; reread attempted or explicit skip reason. The fixture test
controls provider responses, not real-world OCR accuracy.

`visible_text` contains only OCR/AI agreed characters. `unconfirmed_label_text`
retains single-reader observations with crop index, source and legibility; it
must not supply confirmed identity. Box quality is exported separately from
crop status: unrefined bands are not refined model-line evidence.

Learning-loop follow-on: technician choices influenced by AI remain assertions.
Only independently verified and reviewer-approved identities qualify as
confirmed examples. Candidate values are ranking scores until calibrated;
held-out photos never enter the example library or tuning set.
