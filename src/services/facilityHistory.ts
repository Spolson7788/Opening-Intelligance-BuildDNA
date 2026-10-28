import { openingsForOrgSubquery, serviceEventVisibleSql } from '../db/tenantScope';
import { conditionObservationView } from './conditionObservations';

// Caller owns a repeatable-read, read-only transaction. No joins multiply evidence rows.
export async function facilityHistory(c: any, anchor: string, organizationId: string) {
  const access = (await c.query(`SELECT b.property_id FROM openings o JOIN buildings b ON b.id=o.building_id
    WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})`, [anchor, organizationId])).rows[0];
  if (!access) return null;
  const openings = (await c.query(`SELECT o.id,o.opening_code,o.status,o.revision,o.install_date::text
    FROM openings o JOIN buildings b ON b.id=o.building_id WHERE b.property_id=$1
    AND o.id IN (${openingsForOrgSubquery(2)}) ORDER BY o.id LIMIT 1001`, [access.property_id, organizationId])).rows;
  if (openings.length > 1000) throw Error('facility_history_too_large');
  const ids = openings.map((o: any) => o.id);
  const rows = async (table: string, columns = '*') => {
    const result = (await c.query(`SELECT ${columns} FROM ${table} WHERE opening_id=ANY($1::uuid[]) ORDER BY id LIMIT 10001`, [ids])).rows;
    if (result.length > 10000) throw Error('facility_history_too_large');
    return result;
  };
  const frames = await rows('opening_frames', 'id,opening_id,condition');
  const leaves = await rows('door_leaves', 'id,opening_id,leaf_role,condition');
  const components = await rows('hardware_components', `id,opening_id,component_type,manufacturer,model_number,tracker_id,
    mounting_scope,frame_id,door_leaf_id,lifecycle_state,position_id,supersedes_component_id,condition,install_date::text,warranty_expiration::text`);
  const facts = await rows('installation_facts');
  const observations = await rows('condition_observations');
  const records = await rows('lifecycle_records');
  const replacements = await rows('component_replacements');
  const positions = await rows('component_positions');
  const services = (await c.query(`SELECT * FROM service_events WHERE opening_id=ANY($1::uuid[]) AND ${serviceEventVisibleSql('service_events', 2)} ORDER BY id LIMIT 10001`, [ids, organizationId])).rows;
  if (services.length > 10000) throw Error('facility_history_too_large');
  const chain = (items: any[]) => {
    const corrected = new Set(items.map(r => r.correction_of).filter(Boolean));
    return items.map(r => ({ ...r, is_current: !corrected.has(r.id) }));
  };
  return {
    report_type: 'facility_condition_lifecycle_evidence', report_version: 1,
    property_id: access.property_id, access_anchor_opening_id: anchor,
    as_of: (await c.query('SELECT transaction_timestamp() AS as_of')).rows[0].as_of,
    scope: 'authorized_openings_in_one_facility_including_retired_instances',
    limitations: [
      'Observed dates and recorded timestamps are separate. Unknown dates remain unknown; legacy dates are unreviewed.',
      'Correction heads are not an inferred latest condition. Current assessments remain separate from observations.',
      'Literal manufacturer identities only; no aliases, recency, exposure or reliability scoring.',
      'Service events occur once by their original ID. No cost or downtime totals across openings are calculated.',
      'Warranty terms and references do not establish coverage. This is not the facility financial evidence report.',
    ],
    openings: openings.map((o: any) => ({ ...o, legacy_installation_review_state: 'unreviewed' })),
    frames, door_leaves: leaves,
    hardware_components: components.map((h: any) => ({ ...h, legacy_installation_review_state: 'unreviewed', legacy_warranty_review_state: 'unreviewed' })),
    installation_facts: chain(facts), condition_observations: chain(observations).map(r => ({ opening_id: r.opening_id, ...conditionObservationView(r) })),
    lifecycle_records: chain(records), replacements, positions, service_events: services,
  };
}
