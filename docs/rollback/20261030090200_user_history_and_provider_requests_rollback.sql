-- Roll the code back first. Destroys user history and provider requests: export them before running.
DROP TABLE IF EXISTS provider_assignment_requests;
DROP TABLE IF EXISTS user_history;
DROP FUNCTION IF EXISTS provider_assignment_requests_guard();
DROP FUNCTION IF EXISTS user_history_actor_check();
DROP FUNCTION IF EXISTS user_history_append_only();
