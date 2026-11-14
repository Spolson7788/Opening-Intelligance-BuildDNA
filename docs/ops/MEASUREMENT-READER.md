# Door measurement photo reader

Door & Frame can ask Claude to suggest inches from an Apple Measure screenshot. The phone stores the photo with the existing opening photo queue. Nothing is written to the frame or a leaf until the technician uses a suggestion and saves.

The route is `POST /api/openings/:id/measurement-reading`. It checks that the opening belongs to the signed-in company and returns suggestions. It does not update `opening_frames` or `door_leaves`. A reply with no printed measurement returns no suggestions. A reply that names a size but is not valid JSON returns `measurement_response_unreadable` and still writes nothing. An Anthropic error is logged once, without the key, request headers, or image. `401` and `403` return `measurement_reader_auth`. `429` returns `measurement_reader_rate_limited`. `529` and other `5xx` responses return `measurement_reader_overloaded`. `400`, `404`, and `413` return `measurement_reader_rejected`. Any other provider failure, including a non-JSON body, returns `measurement_reader_failed`. The phone can choose a saved screenshot or take a photo, and it sends JPEG, PNG, GIF, or WebP within the reader size limit. HEIC and oversized photos are reduced on the phone first.

The route is available only where recognition is available. The Netlify entry turns recognition on for the two staging sites. Production site `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` is included only while `OI_RECOGNITION_ENABLED` is `true` and `OI_MEASUREMENT_READER` is `anthropic`. Any other site id stays off. The Claude call also stays off unless recognition itself is enabled and the existing Anthropic key is present.

- `OI_MEASUREMENT_READER` — `mock` or `anthropic`. When it is unset, the route answers `measurement_reader_not_selected`.
- `OI_RECOGNITION_ENABLED` — must be `true` before `anthropic` calls Claude. This is the same switch recognition uses.
- `ANTHROPIC_API_KEY` — the existing recognition key. Sent as `x-api-key` to `https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`. Do not commit it.
- `OI_MEASUREMENT_READER_MODEL` — optional. When it is unset, the call uses `claude-sonnet-4-5-20250929`.

`OI_MEASUREMENT_READER_URL` and `OI_MEASUREMENT_READER_API_KEY` are not used. `mock` returns the sample suggestions in `src/services/measurementReader.ts` and does not call the network. Tests use that. Staging needs `OI_MEASUREMENT_READER=anthropic` plus the recognition switch and key already used for Claude. Production enables this route only when those same two flags are set on site `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01`. The Anthropic key is still required before a Claude call runs.
