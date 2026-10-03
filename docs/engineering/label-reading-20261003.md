# Label reading in connected staging

The original full-photograph identification runs beside label localization. The localization pass excludes installation paper, tools and background text. Bounded label crops retain their source image and coordinates and are rotated from original pixels; upscaling adds no new photographic detail.

A locally bundled Tesseract OCR engine and the existing Anthropic vision model read the crops independently. No manufacturer catalog or technician model hint is supplied to either label reader. Exact token agreement is retained; missing suffixes and 0/O substitutions are never silently repaired. Single-reader LCN candidates remain explicitly unconfirmed. Partial 4040 identity can retrieve candidate 4040XP/4041 DA references, without changing the photograph suggestion to either exact variant. Technician review and purchasing department verification remain required.

Label evidence is saved in recognition_runs.stage_one.label_reading with prompt version, image/region coordinates, both readings, agreement, candidate provenance and bounded failure status. Crops are transient and are not public artifacts. The existing original-photo retention flow remains in place. No secret values or provider bodies are logged.

One request is bounded to six label regions, six OCR crops (up to twelve bounded OCR attempts, with a contrast fallback), and two extra vision calls. Label-service failure preserves the ordinary photograph analysis and is recorded as unavailable/partial. The synchronous pipeline has bounded provider/worker deadlines; OCR workers terminate after each request. OCR assets are bundled locally and no runtime training-data download is needed.

## Accuracy acceptance

Run `node scripts/reference/score-label-reading.mjs PRIVATE_HELD_OUT.jsonl` on independently labeled cases, with case_id, split=held_out, human_readable, expected_markings and read_markings. Feed only the manufacturer/model identifier tokens actually read, not catalog descriptions or technician inputs. Keep the same product/photo sweep in one split; exclude development examples from held-out evaluation. Preserve unreadable examples and wrong confident readings.

The 90% target is not demonstrated by current examples. The tool reports exact reading accuracy over all human-readable cases (including abstentions), wrong readings, abstentions, unreadable frequency, false readings on unreadable cases, and a Wilson 95% lower bound. The conservative release gate requires at least 100 readable held-out cases, a lower bound of at least 90%, and no invented readings in unreadable cases. Inspect manufacturer/device/lighting subgroups before claiming field readiness.

Local replay of the two supplied LCN photographs using manually located crops did not produce reliable Tesseract readings. Cropping exposes the label for the vision reader, but that is not proof of model accuracy or successful automatic localization. Live staging replay and a representative held-out corpus remain required. Do not describe this patch as reaching 90% accuracy.
