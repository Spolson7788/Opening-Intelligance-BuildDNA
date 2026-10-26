import { z } from 'zod';
import { installationDateSchema } from './installationFacts';

// Observed dates are evidence, not the server's recording timestamp. The shared
// calendar schema preserves unknown/partial dates without synthesizing precision.
export const conditionObservationSchema = z.object({
  target: z.object({ type: z.enum(['frame', 'door_leaf', 'component']), id: z.string().uuid() }).strict(),
  condition: z.enum(['good', 'worn', 'failed', 'unverified']),
  observed_date: installationDateSchema,
  source_reference: z.string().trim().min(1).max(2000),
  note: z.string().trim().max(4000),
  correction_of: z.string().uuid().nullable(),
  correction_reason: z.string().trim().max(2000),
}).strict().superRefine((p, ctx) => {
  if (Boolean(p.correction_of) !== Boolean(p.correction_reason)) {
    ctx.addIssue({ code: 'custom', message: 'A correction requires both the previous observation and a reason.' });
  }
});

export function conditionObservationView(row: any) {
  return {
    id: row.id,
    target: { type: row.target_type, id: row.target_id },
    condition: row.condition,
    observed_date: { certainty: row.certainty, precision: row.precision, year: row.year, month: row.month, day: row.day },
    source_reference: row.source_reference, note: row.note,
    correction_of: row.correction_of, correction_reason: row.correction_reason,
    recorded_by_user_id: row.recorded_by_user_id,
    recording_organization_id: row.recording_organization_id,
    recorded_at: row.recorded_at,
    target_snapshot: row.target_snapshot,
    // Current means not corrected, NOT the latest physical condition.
    is_current: row.is_current ?? true,
  };
}

export function conditionTargetView(type: 'frame' | 'door_leaf' | 'component', row: any) {
  const leaf = row.leaf_role ? `${row.leaf_role} leaf` : null;
  const label = type === 'frame' ? 'Frame' : type === 'door_leaf' ? `Door ${leaf}` :
    [row.component_type?.replace(/_/g, ' '), leaf || row.mounting_scope,
      row.manufacturer, row.model_number, row.tracker_id].filter(Boolean).join(' / ');
  return {
    target: { type, id: row.id }, label,
    mounting_scope: type === 'component' ? row.mounting_scope : type,
    frame_id: type === 'frame' ? row.id : row.frame_id ?? null,
    door_leaf_id: type === 'door_leaf' ? row.id : row.door_leaf_id ?? null,
    leaf_role: row.leaf_role ?? null, tracker_id: row.tracker_id ?? null,
    lifecycle_state: row.lifecycle_state ?? null,
  };
}
