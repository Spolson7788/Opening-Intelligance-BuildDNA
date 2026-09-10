export type JobState =
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'COMPLETE'
  | 'BLOCKED'
  | 'RETRY'
  | 'FAILED_VALIDATION'
  | 'PLATFORM_LIMITED'
  | 'SATISFIED_BY_EXISTING_STATE';

export type StopCondition =
  | 'AUTHENTICATION_REQUIRED'
  | 'LICENSE_REQUIRED'
  | 'USER_APPROVAL_REQUIRED'
  | 'IDENTITY_CONFLICT'
  | 'GEOMETRY_EVIDENCE_MISSING'
  | 'DESTRUCTIVE_OR_CONSEQUENTIAL_DECISION_REQUIRED'
  | 'WORKSTREAM_WIDE_BLOCKER'
  | 'PLATFORM_EXECUTION_LIMIT_REACHED'
  | 'NO_ELIGIBLE_AUTHORIZED_WORK_REMAINS';

export interface ResumeJob {
  job_id: string;
  resume_id: string;
  authorized_manufacturer_group: string;
  execution_owner: string;
  repository: string;
  branch: string;
  checkpoint_commit: string;
  active_source_row_ref: string | null;
  canonical_product_id: string | null;
  task_type: string;
  active_stage: string;
  first_unfinished_task: string;
  priority: number;
  claim_state: JobState;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  valid_stop_conditions: StopCondition[];
  completed_task_keys: string[];
  last_result: string | null;
}

export interface ExecutionClaim {
  job_id: string;
  executor_id: string;
  executor_scope: string;
  claimed_at: string;
  last_heartbeat: string;
  state: 'CLAIMED' | 'RUNNING';
}

export interface ExecutionHeartbeat {
  executor_id: string;
  job_id: string;
  last_heartbeat: string;
  last_progress_commit: string | null;
  active_identity: string | null;
  active_stage: string;
  first_unfinished_task: string;
}

export interface ExecutionAuditEvent {
  timestamp: string;
  executor_id: string;
  job_id: string;
  event: string;
  from_state: JobState | null;
  to_state: JobState | null;
  detail: string;
}

export interface QueueDocument {
  schema_version: '1.0';
  paid_execution_enabled: false;
  jobs: ResumeJob[];
}

export interface ClaimsDocument {
  schema_version: '1.0';
  claims: ExecutionClaim[];
}

export interface HeartbeatsDocument {
  schema_version: '1.0';
  heartbeats: ExecutionHeartbeat[];
}

export interface PlatformLimitCheckpoint {
  repository: string;
  branch: string;
  checkpoint_commit: string;
  authorized_manufacturer_group: string;
  execution_owner: string;
  active_source_row_ref: string | null;
  canonical_product_id: string | null;
  active_stage: string;
  first_unfinished_task: string;
  completed_task_keys: string[];
}
