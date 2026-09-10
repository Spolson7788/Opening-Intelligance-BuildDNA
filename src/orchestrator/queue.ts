import {
  ClaimsDocument,
  ExecutionAuditEvent,
  ExecutionClaim,
  QueueDocument,
  ResumeJob,
} from './types';

export const DEFAULT_STALE_CLAIM_MS = 15 * 60 * 1000;

export function assertManufacturerOwnership(job: ResumeJob, executorScope: string): void {
  if (job.authorized_manufacturer_group !== executorScope) {
    throw new Error(
      `MANUFACTURER_SCOPE_MISMATCH: job=${job.authorized_manufacturer_group} executor=${executorScope}`,
    );
  }
}

export function isClaimStale(
  claim: ExecutionClaim,
  now: Date,
  staleAfterMs = DEFAULT_STALE_CLAIM_MS,
): boolean {
  return now.getTime() - new Date(claim.last_heartbeat).getTime() > staleAfterMs;
}

export function releaseStaleClaims(
  claims: ClaimsDocument,
  now: Date,
  staleAfterMs = DEFAULT_STALE_CLAIM_MS,
): string[] {
  const released: string[] = [];
  claims.claims = claims.claims.filter((claim) => {
    const stale = isClaimStale(claim, now, staleAfterMs);
    if (stale) released.push(claim.job_id);
    return !stale;
  });
  return released;
}

function eligibleForClaim(job: ResumeJob): boolean {
  return job.claim_state === 'QUEUED' || job.claim_state === 'RETRY' || job.claim_state === 'PLATFORM_LIMITED';
}

export function claimNextJob(
  queue: QueueDocument,
  claims: ClaimsDocument,
  executorId: string,
  executorScope: string,
  now = new Date(),
): { job: ResumeJob | null; audit: ExecutionAuditEvent[] } {
  const audit: ExecutionAuditEvent[] = [];
  const released = releaseStaleClaims(claims, now);
  for (const jobId of released) {
    const job = queue.jobs.find((candidate) => candidate.job_id === jobId);
    if (job && job.claim_state !== 'COMPLETE') {
      const from = job.claim_state;
      job.claim_state = 'RETRY';
      job.updated_at = now.toISOString();
      audit.push({
        timestamp: now.toISOString(),
        executor_id: executorId,
        job_id: job.job_id,
        event: 'STALE_CLAIM_RELEASED',
        from_state: from,
        to_state: 'RETRY',
        detail: 'Stale claim released for safe retry.',
      });
    }
  }

  const candidates = queue.jobs
    .filter(eligibleForClaim)
    .filter((job) => job.authorized_manufacturer_group === executorScope)
    .filter((job) => !claims.claims.some((claim) => claim.job_id === job.job_id))
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));

  const job = candidates[0] ?? null;
  if (!job) return { job: null, audit };

  assertManufacturerOwnership(job, executorScope);
  const from = job.claim_state;
  job.claim_state = 'CLAIMED';
  job.attempt_count += 1;
  job.updated_at = now.toISOString();
  claims.claims.push({
    job_id: job.job_id,
    executor_id: executorId,
    executor_scope: executorScope,
    claimed_at: now.toISOString(),
    last_heartbeat: now.toISOString(),
    state: 'CLAIMED',
  });
  audit.push({
    timestamp: now.toISOString(),
    executor_id: executorId,
    job_id: job.job_id,
    event: 'JOB_CLAIMED',
    from_state: from,
    to_state: 'CLAIMED',
    detail: `Job claimed within ${executorScope} scope.`,
  });
  return { job, audit };
}

export function startClaimedJob(
  job: ResumeJob,
  claims: ClaimsDocument,
  executorId: string,
  now = new Date(),
): ExecutionAuditEvent {
  const claim = claims.claims.find((candidate) => candidate.job_id === job.job_id);
  if (!claim || claim.executor_id !== executorId) {
    throw new Error(`CLAIM_NOT_OWNED: ${job.job_id}`);
  }
  const from = job.claim_state;
  job.claim_state = 'RUNNING';
  job.updated_at = now.toISOString();
  claim.state = 'RUNNING';
  claim.last_heartbeat = now.toISOString();
  return {
    timestamp: now.toISOString(),
    executor_id: executorId,
    job_id: job.job_id,
    event: 'JOB_STARTED',
    from_state: from,
    to_state: 'RUNNING',
    detail: 'Checkpoint loaded and execution started.',
  };
}

export function heartbeat(
  claims: ClaimsDocument,
  jobId: string,
  executorId: string,
  now = new Date(),
): void {
  const claim = claims.claims.find((candidate) => candidate.job_id === jobId);
  if (!claim || claim.executor_id !== executorId) throw new Error(`CLAIM_NOT_OWNED: ${jobId}`);
  claim.last_heartbeat = now.toISOString();
}

export function completeJob(
  job: ResumeJob,
  claims: ClaimsDocument,
  executorId: string,
  result: string,
  now = new Date(),
): ExecutionAuditEvent {
  const claim = claims.claims.find((candidate) => candidate.job_id === job.job_id);
  if (!claim || claim.executor_id !== executorId) throw new Error(`CLAIM_NOT_OWNED: ${job.job_id}`);
  const from = job.claim_state;
  job.claim_state = 'COMPLETE';
  job.last_result = result;
  job.updated_at = now.toISOString();
  claims.claims = claims.claims.filter((candidate) => candidate.job_id !== job.job_id);
  return {
    timestamp: now.toISOString(),
    executor_id: executorId,
    job_id: job.job_id,
    event: 'JOB_COMPLETED',
    from_state: from,
    to_state: 'COMPLETE',
    detail: result,
  };
}

export function markSatisfiedByExistingState(
  job: ResumeJob,
  claims: ClaimsDocument,
  executorId: string,
  result: string,
  now = new Date(),
): ExecutionAuditEvent {
  const from = job.claim_state;
  job.claim_state = 'SATISFIED_BY_EXISTING_STATE';
  job.last_result = result;
  job.updated_at = now.toISOString();
  claims.claims = claims.claims.filter((candidate) => candidate.job_id !== job.job_id);
  return {
    timestamp: now.toISOString(),
    executor_id: executorId,
    job_id: job.job_id,
    event: 'JOB_SATISFIED_BY_EXISTING_STATE',
    from_state: from,
    to_state: 'SATISFIED_BY_EXISTING_STATE',
    detail: result,
  };
}

export function buildResumeInstruction(job: ResumeJob): string {
  return [
    'Resume from the exact persisted checkpoint.',
    `Repository: ${job.repository}.`,
    `Branch: ${job.branch}.`,
    `Checkpoint commit: ${job.checkpoint_commit}.`,
    job.active_source_row_ref ? `Active row: ${job.active_source_row_ref}.` : null,
    job.canonical_product_id ? `Canonical identity: ${job.canonical_product_id}.` : null,
    `Active stage: ${job.active_stage}.`,
    `First unfinished task: ${job.first_unfinished_task}`,
    'Do not repeat completed work. Continue all authorized manufacturer-scoped work until the next valid stop condition.',
    'If another platform execution limit occurs, persist the new deterministic checkpoint before stopping.',
  ]
    .filter(Boolean)
    .join(' ');
}
