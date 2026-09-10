import { createHash } from 'node:crypto';
import { PlatformLimitCheckpoint, ResumeJob } from './types';

function stableId(prefix: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

export function checkpointToResumeJob(
  checkpoint: PlatformLimitCheckpoint,
  now = new Date(),
  priority = 100,
): ResumeJob {
  const identityKey = [
    checkpoint.repository,
    checkpoint.branch,
    checkpoint.checkpoint_commit,
    checkpoint.active_source_row_ref ?? '',
    checkpoint.canonical_product_id ?? '',
    checkpoint.active_stage,
    checkpoint.first_unfinished_task,
  ].join('|');
  const resumeId = stableId('resume', identityKey);
  const jobId = stableId('job', `${resumeId}|${checkpoint.execution_owner}`);

  return {
    job_id: jobId,
    resume_id: resumeId,
    authorized_manufacturer_group: checkpoint.authorized_manufacturer_group,
    execution_owner: checkpoint.execution_owner,
    repository: checkpoint.repository,
    branch: checkpoint.branch,
    checkpoint_commit: checkpoint.checkpoint_commit,
    active_source_row_ref: checkpoint.active_source_row_ref,
    canonical_product_id: checkpoint.canonical_product_id,
    task_type: 'PLATFORM_LIMIT_RESUME',
    active_stage: checkpoint.active_stage,
    first_unfinished_task: checkpoint.first_unfinished_task,
    priority,
    claim_state: 'PLATFORM_LIMITED',
    attempt_count: 0,
    max_attempts: 5,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    valid_stop_conditions: [
      'AUTHENTICATION_REQUIRED',
      'LICENSE_REQUIRED',
      'USER_APPROVAL_REQUIRED',
      'IDENTITY_CONFLICT',
      'GEOMETRY_EVIDENCE_MISSING',
      'DESTRUCTIVE_OR_CONSEQUENTIAL_DECISION_REQUIRED',
      'WORKSTREAM_WIDE_BLOCKER',
      'PLATFORM_EXECUTION_LIMIT_REACHED',
      'NO_ELIGIBLE_AUTHORIZED_WORK_REMAINS',
    ],
    completed_task_keys: [...checkpoint.completed_task_keys],
    last_result: null,
  };
}

export function enqueueCheckpoint(
  jobs: ResumeJob[],
  checkpoint: PlatformLimitCheckpoint,
  now = new Date(),
): ResumeJob {
  const job = checkpointToResumeJob(checkpoint, now);
  const existing = jobs.find((candidate) => candidate.resume_id === job.resume_id);
  if (existing) return existing;
  jobs.push(job);
  return job;
}
