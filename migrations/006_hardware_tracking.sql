-- Every hardware part gets a permanent, auto-generated tracker ID — never
-- client-supplied, same pattern as openings.qr_token — plus real shipment
-- tracking fields, so a part can be followed from ordered through installed.

ALTER TABLE hardware_components ADD COLUMN tracker_id TEXT;
-- Backfill existing rows before enforcing NOT NULL/UNIQUE — derive from the
-- row's own UUID so backfilled values are guaranteed unique without needing
-- application code to run.
UPDATE hardware_components SET tracker_id = 'TRK-' || UPPER(SUBSTRING(id::text, 1, 8))
  WHERE tracker_id IS NULL;
ALTER TABLE hardware_components ALTER COLUMN tracker_id SET NOT NULL;
ALTER TABLE hardware_components ADD CONSTRAINT hardware_components_tracker_id_key UNIQUE (tracker_id);

ALTER TABLE hardware_components ADD COLUMN serial_number TEXT; -- manufacturer-stamped serial, user-entered
ALTER TABLE hardware_components ADD COLUMN carrier TEXT;
ALTER TABLE hardware_components ADD COLUMN tracking_number TEXT;
ALTER TABLE hardware_components ADD COLUMN shipment_status TEXT NOT NULL DEFAULT 'not_shipped'
  CHECK (shipment_status IN ('not_shipped', 'ordered', 'shipped', 'in_transit', 'delivered', 'installed', 'other'));
ALTER TABLE hardware_components ADD COLUMN expected_delivery_date DATE;
ALTER TABLE hardware_components ADD COLUMN shipped_date DATE;
ALTER TABLE hardware_components ADD COLUMN delivered_date DATE;

CREATE INDEX idx_hardware_tracker_id ON hardware_components(tracker_id);
