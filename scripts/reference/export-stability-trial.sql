-- psql -X -qAt -v trial_id=<uuid> -f scripts/reference/export-stability-trial.sql
-- Read-only export; request manifests contain image hashes, not image bytes.
WITH trial AS (
 SELECT * FROM recognition_stability_trials WHERE id=:'trial_id'::uuid
), runs AS (
 SELECT r.* FROM recognition_runs r JOIN recognition_stability_runs s ON s.run_id=r.id
 JOIN trial t ON t.id=s.trial_id
), attempts AS (
 SELECT a.* FROM recognition_provider_attempts a JOIN runs r ON r.id=a.run_id
)
SELECT jsonb_build_object(
 'export_version','oi-stability-export-3',
 'exported_at',now(),
 'cost_basis','List-price usage estimates, not an invoice',
 'trial',(SELECT to_jsonb(t) FROM trial t),
 'runs',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id) FROM runs r),'[]'::jsonb),
 'identity_reviews',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'run_id',r.id,'final_identity',jsonb_build_object('manufacturer',r.suggestion->'manufacturer','series',r.suggestion->'series','model',r.suggestion->'model'),
   'catalog_identity_review',r.stage_one->'catalog_identity_review',
   'photo_identity',r.stage_one->'photograph_identity',
   'label_reading',r.stage_one->'label_reading'
  ) ORDER BY r.created_at,r.id) FROM runs r),'[]'::jsonb),
 'technician_confirmations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'hardware_component_id',h.id,'run_id',h.identity_recognition_run_id,
   'manufacturer',h.manufacturer,'model',h.model_number,
   'identity_status',h.identity_status,'identity_source',h.identity_source,
   'acknowledged_by',h.identity_acknowledged_by,'acknowledged_at',h.identity_acknowledged_at
  ) ORDER BY h.id) FROM hardware_components h JOIN runs r ON r.id=h.identity_recognition_run_id
   WHERE h.opening_id=r.opening_id AND h.identity_acknowledged_by IS NOT NULL
    AND h.identity_acknowledged_at IS NOT NULL),'[]'::jsonb),
 'provider_attempts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.started_at,a.id) FROM attempts a),'[]'::jsonb),
 'reservations',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.attempt_id) FROM recognition_stability_reservations b JOIN trial t ON t.id=b.trial_id),'[]'::jsonb)
);
