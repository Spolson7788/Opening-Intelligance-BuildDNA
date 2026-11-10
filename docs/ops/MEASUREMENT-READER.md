# Door measurement photo reader

Door & Frame can ask a vision model to suggest inches from an Apple Measure screenshot. The phone stores the photo with the existing opening photo queue. Nothing is written to the frame or a leaf until the technician confirms a suggestion and saves.

The route is `POST /api/openings/:id/measurement-reading`. It checks that the opening belongs to the signed-in company and returns suggestions. It does not update `opening_frames` or `door_leaves`.

Set these environment variables on the server that should call a model. The provider and the cost are Stephan's choice. This build does not add a key.

- `OI_MEASUREMENT_READER` — `mock`, `openai`, `anthropic`, or `gemini`. When it is unset, the route answers `measurement_reader_not_selected`.
- `OI_MEASUREMENT_READER_URL` — where a live provider receives the image. Required for `openai`, `anthropic`, and `gemini`.
- `OI_MEASUREMENT_READER_API_KEY` — bearer token for that URL. Required for a live provider. Do not commit it.
- `OI_MEASUREMENT_READER_MODEL` — optional model name sent with the image.

`mock` returns the sample suggestions in `src/services/measurementReader.ts` and does not call the network. Tests use that. A live provider POSTs JSON `{ provider, model, content_type, image_base64 }` and expects `{ suggestions: [{ field, inches, confidence, bounds }] }`. Fields are `frame_width`, `frame_height`, `active_width`, `active_height`, `inactive_width`, and `inactive_height`.
