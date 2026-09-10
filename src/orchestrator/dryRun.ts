import { createHash } from 'node:crypto';
import { checkpointToResumeJob } from './checkpoint';
import {
  buildResumeInstruction,
  claimNextJob,
  completeJob,
  markSatisfiedByExistingState,
  startClaimedJob,
} from './queue';
import {
  ClaimsDocument,
  ExecutionAuditEvent,
  PlatformLimitCheckpoint,
  QueueDocument,
} from './types';

export interface DryRunInput {
  checkpoint: PlatformLimitCheckpoint;
  executor_id: string;
  executor_scope: string;
  already_completed_task_keys?: string[];
  simulated_completed_task_key?: string;
  now?: Date;
}

export interface DryRunResult {
  paid_execution_enabled: false;
  resume_instruction: string;
  job_id: string;
  final_state: string;
  simulated_output_commit: string;
  duplicate_work_performed: false;
  audit: ExecutionAuditEvent[];
}

function simulatedCommit(jobId: string, task: string): string {
  return createHash('sha256').update(`dry-run|${jobId}|${task}`).digest('hex').slice(0, 40);
}

export function runDryResumeSimulation(input: DryRunInput): DryRunResult {
  const now = input.now ?? new Date();
  const job = checkpointToResumeJob(input.checkpoint, now);
  const queue: QueueDocument = {
    schema_version: '1.0',
    paid_execution_enabled: false,
    jobs: [job],
  };
  const claims: ClaimsDocument = { schema_version: '1.0', claims: [] };
  const audit: ExecutionAuditEvent[] = [];

  const claimed = claimNextJob(queue, claims, input.executor_id, input.executor_scope, now);
  audit.push(...claimed.audit);
  if (!claimed.job) throw new Error('DRY_RUN_NO_CLAIMABLE_JOB');
  audit.push(startClaimedJob(claimed.job, claims, input.executor_id, now));

  const completed = new Set([
    ...claimed.job.completed_task_keys,
    ...(input.already_completed_task_keys ?? []),
  ]);
  const taskKey = input.simulated_completed_task_key ?? claimed.job.first_unfinished_task;

  if (completed.has(taskKey)) {
    audit.push(
      markSatisfiedByExistingState(
        claimed.job,
        claims,
        input.executor_id,
        `Task already completed at checkpoint: ${taskKey}`,
        now,
      ),
    );
    return {
      paid_execution_enabled: false,
      resume_instruction: buildResumeInstruction(claimed.job),
      job_id: claimed.job.job_id,
      final_state: claimed.job.claim_state,
      simulated_output_commit: simulatedCommit(claimed.job.job_id, 'existing-state'),
      duplicate_work_performed: false,
      audit,
    };
  }

  claimed.job.completed_task_keys.push(taskKey);
  const commit = simulatedCommit(claimed.job.job_id, taskKey);
  audit.push(
    completeJob(
      claimed.job,
      claims,
      input.executor_id,
      `DRY_RUN_COMPLETED:${taskKey}; simulated_commit=${commit}`,
      now,
    ),
  );

  return {
    paid_execution_enabled: false,
    resume_instruction: buildResumeInstruction(claimed.job),
    job_id: claimed.job.job_id,
    final_state: claimed.job.claim_state,
    simulated_output_commit: commit,
    duplicate_work_performed: false,
    audit,
  };
}
