-- Adds replacement cost and "who to call" supplier info directly to each
-- hardware part, so a facilities manager doesn't have to look either up
-- separately. unit_cost feeds the capital forecast (real numbers where
-- known, falling back to the type-based estimate where not).

ALTER TABLE hardware_components ADD COLUMN unit_cost NUMERIC(10,2);
ALTER TABLE hardware_components ADD COLUMN supplier_name TEXT;
ALTER TABLE hardware_components ADD COLUMN supplier_contact TEXT;
