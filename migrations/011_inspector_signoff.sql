-- Inspector sign-off: a captured signature on an inspection is what gives
-- the compliance report real legal weight — the digital equivalent of
-- signing a paper inspection log. Nullable at the schema/API level on
-- purpose (a dashboard-entered backfill of historical inspection data
-- shouldn't be blocked by a DB constraint requiring a signature that never
-- existed) — the field app's actual inspection form is where signing gets
-- required, at the UI layer, since that's the real point of capture.
ALTER TABLE inspection_events ADD COLUMN signature_data TEXT;   -- base64 PNG data URL of the captured signature
ALTER TABLE inspection_events ADD COLUMN signed_by_name TEXT;   -- typed/confirmed name — a canvas squiggle alone doesn't self-identify the signer
ALTER TABLE inspection_events ADD COLUMN signed_at TIMESTAMPTZ; -- when the signature was captured
