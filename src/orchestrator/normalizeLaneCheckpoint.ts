import { PlatformLimitCheckpoint } from './types';

export interface LaneRegistryEntry {
  lane_id: string;
  authorized_manufacturer_group: string;
  execution_owner: string;
  branch: string;
  checkpoint_path: string;
}

export interface LaneCheckpointOverrides {
  checkpoint_commit: string;
  platform_execution_limit_reached?: boolean;
  active_source_row_ref?: string | null;
  canonical_product_id?: string | null;
  active_stage?: string;
  first_unfinished_task?: string;
}

type JsonRecord = Record<string, unknown>;

function getPath(input: JsonRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as JsonRecord)[key];
  }, input);
}

function firstString(input: JsonRecord, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getPath(input, path);
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function stringsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function checkpointSignalsPlatformLimit(raw: JsonRecord): boolean {
  const candidates = [
    firstString(raw, ['status']),
    firstString(raw, ['lane_state']),
    firstString(raw, ['platform_limit_state']),
    firstString(raw, ['stop_condition']),
  ].filter(Boolean);
  return candidates.some((value) => value?.includes('PLATFORM_EXECUTION_LIMIT_REACHED'));
}

export function normalizeLaneCheckpoint(
  raw: JsonRecord,
  lane: LaneRegistryEntry,
  overrides: LaneCheckpointOverrides,
): PlatformLimitCheckpoint | null {
  const platformLimited =
    overrides.platform_execution_limit_reached === true || checkpointSignalsPlatformLimit(raw);
  if (!platformLimited) return null;

  const activeSourceRow =
    overrides.active_source_row_ref ??
    firstString(raw, [
      'active_source_row_ref',
      'active_work_item.source_row_ref',
      'imagery_execution.source_row_ref',
      'assa_abloy_missing_published_dimension_backfill.active_source_row_ref',
      'active_hager_execution.source_row_ref',
    ]) ??
    null;

  const canonicalProductId =
    overrides.canonical_product_id ??
    firstString(raw, [
      'canonical_product_id',
      'active_geometry_identity',
      'active_work_item.canonical_product_id',
      'imagery_execution.canonical_product_id',
      'active_hager_execution.canonical_product_id',
    ]) ??
    null;

  const activeStage =
    overrides.active_stage ??
    firstString(raw, [
      'active_stage',
      'active_work_item.stage',
      'lane_state',
      'status',
      'imagery_execution.state',
      'assa_abloy_missing_published_dimension_backfill.state',
    ]) ??
    'UNKNOWN_ACTIVE_STAGE';

  const firstUnfinishedTask =
    overrides.first_unfinished_task ??
    firstString(raw, [
      'first_unfinished_task',
      'active_work_item.first_unfinished_task',
      'current_action',
      'resume_rule',
    ]);

  if (!firstUnfinishedTask) {
    throw new Error(`CHECKPOINT_MISSING_FIRST_UNFINISHED_TASK:${lane.lane_id}`);
  }

  const completedTaskKeys = [
    ...stringsFromUnknown(getPath(raw, 'completed_task_keys')),
    ...stringsFromUnknown(getPath(raw, 'completed_this_checkpoint')),
  ];

  return {
    repository: firstString(raw, ['repository']) ?? 'BuildDNA/opening-intel',
    branch: firstString(raw, ['branch']) ?? lane.branch,
    checkpoint_commit: overrides.checkpoint_commit,
    authorized_manufacturer_group: lane.authorized_manufacturer_group,
    execution_owner: lane.execution_owner,
    active_source_row_ref: activeSourceRow,
    canonical_product_id: canonicalProductId,
    active_stage: activeStage,
    first_unfinished_task: firstUnfinishedTask,
    completed_task_keys: completedTaskKeys,
  };
}
