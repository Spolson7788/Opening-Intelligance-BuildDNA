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
 'export_version','oi-stability-export-2',
 'exported_at',now(),
 'cost_basis','List-price usage estimates, not an invoice',
 'trial',(SELECT to_jsonb(t) FROM trial t),
 'runs',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id) FROM runs r),'[]'::jsonb),
 'provider_attempts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.started_at,a.id) FROM attempts a),'[]'::jsonb),
 'reservations',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.attempt_id) FROM recognition_stability_reservations b JOIN trial t ON t.id=b.trial_id),'[]'::jsonb)
);
