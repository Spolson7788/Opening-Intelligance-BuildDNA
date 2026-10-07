-- A pending or unclassified analysis is not an identified Other component.
ALTER TABLE recognition_runs ALTER COLUMN component_type DROP NOT NULL;
