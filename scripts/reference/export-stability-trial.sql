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
 'technician_confirmations',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.acknowledged_at,c.id) FROM identity_confirmations c JOIN runs r ON r.id=c.run_id),'[]'::jsonb),
 'miss_queue',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM recognition_miss_queue m JOIN runs r ON r.id=m.run_id),'[]'::jsonb),
 'provider_attempts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.started_at,a.id) FROM attempts a),'[]'::jsonb),
 'reservations',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.attempt_id) FROM recognition_stability_reservations b JOIN trial t ON t.id=b.trial_id),'[]'::jsonb)
);
