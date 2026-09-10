import { describe, expect, it } from 'vitest';
import { checkpointToResumeJob } from './checkpoint';
import { runDryResumeSimulation } from './dryRun';
import { normalizeLaneCheckpoint } from './normalizeLaneCheckpoint';
import {
  assertManufacturerOwnership,
  claimNextJob,
  isClaimStale,
  releaseStaleClaims,
} from './queue';
import { ClaimsDocument, PlatformLimitCheckpoint, QueueDocument } from './types';

const checkpoint: PlatformLimitCheckpoint = {
  repository: 'BuildDNA/opening-intel',
  branch: 'oi-hager-evidence',
  checkpoint_commit: 'abc123',
  authorized_manufacturer_group: 'HAGER',
  execution_owner: 'HAGER_LANE',
  active_source_row_ref: 'CAD-3D Assets!235',
  canonical_product_id: 'HAGER-EXIT-DEVICE-4500-4501-MORTISE',
  active_stage: 'VIEW_SPECIFIC_GEOMETRY_AUDIT',
  first_unfinished_task: 'Evaluate exact evidence for independently releasable views.',
  completed_task_keys: ['persist-4601-rim-hero'],
};

describe('checkpoint ingestion', () => {
  it('creates stable resumable jobs without enabling paid execution', () => {
    const now = new Date('2026-09-08T15:00:00Z');
    const first = checkpointToResumeJob(checkpoint, now);
    const second = checkpointToResumeJob(checkpoint, now);
    expect(first.job_id).toBe(second.job_id);
    expect(first.resume_id).toBe(second.resume_id);
    expect(first.claim_state).toBe('PLATFORM_LIMITED');
  });

  it('normalizes a live Hager-style checkpoint when a platform-limit report is present', () => {
    const raw = {
      repository: 'BuildDNA/opening-intel',
      branch: 'oi-hager-evidence',
      active_source_row_ref: 'CAD-3D Assets!235',
      canonical_product_id: 'HAGER-EXIT-DEVICE-4500-4501-MORTISE',
      active_stage: 'VIEW_SPECIFIC_GEOMETRY_AUDIT',
      completed_this_checkpoint: ['4501 Rim hero persisted', '4601 Rim detail persisted'],
      first_unfinished_task: 'Evaluate exact 4501 Mortise evidence.',
      lane_state: 'HAGER_MULTI_IDENTITY_IMAGERY_IN_PROGRESS',
    };
    const normalized = normalizeLaneCheckpoint(
      raw,
      {
        lane_id: 'HAGER',
        authorized_manufacturer_group: 'HAGER',
        execution_owner: 'HAGER_LANE',
        branch: 'oi-hager-evidence',
        checkpoint_path: 'oi-workstreams/hager/CURRENT_CHECKPOINT.json',
      },
      { checkpoint_commit: 'deadbeef', platform_execution_limit_reached: true },
    );
    expect(normalized?.active_source_row_ref).toBe('CAD-3D Assets!235');
    expect(normalized?.canonical_product_id).toBe('HAGER-EXIT-DEVICE-4500-4501-MORTISE');
    expect(normalized?.checkpoint_commit).toBe('deadbeef');
    expect(normalized?.completed_task_keys).toHaveLength(2);
  });

  it('does not enqueue ordinary non-platform-limited checkpoints', () => {
    const normalized = normalizeLaneCheckpoint(
      {
        status: 'NO_ELIGIBLE_AUTHORIZED_WORK_REMAINS',
        resume_rule: 'Wait for new exact evidence.',
      },
      {
        lane_id: 'DORMAKABA',
        authorized_manufacturer_group: 'DORMAKABA',
        execution_owner: 'DORMAKABA_LANE',
        branch: 'oi-dormakaba-evidence',
        checkpoint_path: 'oi-workstreams/dormakaba/CURRENT_CHECKPOINT.json',
      },
      { checkpoint_commit: 'abc999' },
    );
    expect(normalized).toBeNull();
  });
});

describe('manufacturer ownership', () => {
  it('blocks cross-manufacturer execution', () => {
    const job = checkpointToResumeJob(checkpoint, new Date('2026-09-08T15:00:00Z'));
    expect(() => assertManufacturerOwnership(job, 'ASSA_ABLOY')).toThrow('MANUFACTURER_SCOPE_MISMATCH');
  });
});

describe('claim lifecycle', () => {
  it('claims only matching manufacturer work', () => {
    const job = checkpointToResumeJob(checkpoint, new Date('2026-09-08T15:00:00Z'));
    const queue: QueueDocument = { schema_version: '1.0', paid_execution_enabled: false, jobs: [job] };
    const claims: ClaimsDocument = { schema_version: '1.0', claims: [] };
    const result = claimNextJob(queue, claims, 'hager-executor', 'HAGER', new Date('2026-09-08T15:01:00Z'));
    expect(result.job?.job_id).toBe(job.job_id);
    expect(job.claim_state).toBe('CLAIMED');
    expect(claims.claims).toHaveLength(1);
  });

  it('does not hand Hager work to an ASSA ABLOY executor', () => {
    const job = checkpointToResumeJob(checkpoint, new Date('2026-09-08T15:00:00Z'));
    const queue: QueueDocument = { schema_version: '1.0', paid_execution_enabled: false, jobs: [job] };
    const claims: ClaimsDocument = { schema_version: '1.0', claims: [] };
    const result = claimNextJob(queue, claims, 'assa-executor', 'ASSA_ABLOY', new Date('2026-09-08T15:01:00Z'));
    expect(result.job).toBeNull();
  });

  it('detects and releases stale claims', () => {
    const claims: ClaimsDocument = {
      schema_version: '1.0',
      claims: [
        {
          job_id: 'job-1',
          executor_id: 'worker-1',
          executor_scope: 'HAGER',
          claimed_at: '2026-09-08T14:00:00Z',
          last_heartbeat: '2026-09-08T14:00:00Z',
          state: 'RUNNING',
        },
      ],
    };
    expect(isClaimStale(claims.claims[0], new Date('2026-09-08T15:00:00Z'))).toBe(true);
    expect(releaseStaleClaims(claims, new Date('2026-09-08T15:00:00Z'))).toEqual(['job-1']);
    expect(claims.claims).toHaveLength(0);
  });
});

describe('dry-run resume', () => {
  it('resumes the first unfinished task without duplicating checkpointed work', () => {
    const result = runDryResumeSimulation({
      checkpoint,
      executor_id: 'hager-dry-run',
      executor_scope: 'HAGER',
      now: new Date('2026-09-08T15:00:00Z'),
    });
    expect(result.paid_execution_enabled).toBe(false);
    expect(result.final_state).toBe('COMPLETE');
    expect(result.duplicate_work_performed).toBe(false);
    expect(result.resume_instruction).toContain('Do not repeat completed work');
  });

  it('marks a job satisfied when the first unfinished task is already in durable state', () => {
    const result = runDryResumeSimulation({
      checkpoint,
      executor_id: 'hager-dry-run',
      executor_scope: 'HAGER',
      already_completed_task_keys: [checkpoint.first_unfinished_task],
      now: new Date('2026-09-08T15:00:00Z'),
    });
    expect(result.final_state).toBe('SATISFIED_BY_EXISTING_STATE');
    expect(result.duplicate_work_performed).toBe(false);
  });
});
