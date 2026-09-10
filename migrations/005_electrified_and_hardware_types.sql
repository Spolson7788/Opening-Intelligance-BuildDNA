-- Whether an opening has electrified hardware (electric strikes, maglocks,
-- power transfer, etc.) — a real, inspection-relevant flag in its own right,
-- not something to infer from which specific parts happen to be listed.
-- Mirrors the existing fire_rated / life_safety_critical pattern.
ALTER TABLE openings ADD COLUMN is_electrified BOOLEAN NOT NULL DEFAULT false;

-- Expand the hardware taxonomy — the original list (lockset, cylinder,
-- closer, exit_device, hinge, automatic_operator, panic_bar,
-- access_control_reader, other) was too thin for a real door: hinges alone
-- are usually 3 per door, and electrified openings commonly carry a keypad,
-- an electric strike, a power transfer, and/or a maglock as distinct parts.
ALTER TABLE hardware_components DROP CONSTRAINT hardware_components_component_type_check;
ALTER TABLE hardware_components ADD CONSTRAINT hardware_components_component_type_check
  CHECK (component_type IN (
    'lockset', 'cylinder', 'closer', 'exit_device', 'hinge',
    'automatic_operator', 'panic_bar', 'access_control_reader',
    'keypad', 'electric_strike', 'power_transfer', 'maglock',
    'request_to_exit_device', 'other'
  ));
