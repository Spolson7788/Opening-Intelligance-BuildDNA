# Door measurement photo reader

Door & Frame can ask Claude to suggest inches from an Apple Measure screenshot. The phone stores the photo with the existing opening photo queue. Nothing is written to the frame or a leaf until the technician uses a suggestion and saves.

The route is `POST /api/openings/:id/measurement-reading`. It checks that the opening belongs to the signed-in company and returns suggestions. It does not update `opening_frames` or `door_leaves`. A response that is not valid JSON returns `measurement_response_unreadable` and still writes nothing.

The route is available only where recognition is available: the Netlify entry turns recognition on for the two staging sites and leaves it off everywhere else, including production. The Claude call also stays off unless recognition itself is enabled and the existing Anthropic key is present.

- `OI_MEASUREMENT_READER` — `mock` or `anthropic`. When it is unset, the route answers `measurement_reader_not_selected`.
- `OI_RECOGNITION_ENABLED` — must be `true` before `anthropic` calls Claude. This is the same switch recognition uses.
- `ANTHROPIC_API_KEY` — the existing recognition key. Sent as `x-api-key` to `https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`. Do not commit it.
- `OI_MEASUREMENT_READER_MODEL` — optional. When it is unset, the call uses `claude-sonnet-4-5-20250929`.

`OI_MEASUREMENT_READER_URL` and `OI_MEASUREMENT_READER_API_KEY` are not used. `mock` returns the sample suggestions in `src/services/measurementReader.ts` and does not call the network. Tests use that. Staging needs `OI_MEASUREMENT_READER=anthropic` plus the recognition switch and key already used for Claude. Production does not enable this route.
