import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface SignalRule {
  path: string;
  matches?: string;
  exists?: boolean;
}

export interface UnattendedLanePolicy {
  lane_id: string;
  enabled: boolean;
  authorized_manufacturer_group: string;
  execution_owner: string;
  branch: string;
  checkpoint_path: string;
  allowed_write_root: string;
  active_when_any: SignalRule[];
  terminal_when_any: SignalRule[];
}

export interface UnattendedLanePolicyDocument {
  schema_version: string;
  lanes: UnattendedLanePolicy[];
}

export interface DiscoveredLane extends UnattendedLanePolicy {
  checkpoint_commit: string;
  active_stage: string;
  first_unfinished_task: string;
}

type JsonRecord = Record<string, unknown>;

function valueAtPath(input: JsonRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as JsonRecord)[key];
  }, input);
}

function signalMatches(raw: JsonRecord, rule: SignalRule): boolean {
  const value = valueAtPath(raw, rule.path);
  if (rule.exists === true) {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  }
  if (rule.matches) {
    if (value === undefined || value === null) return false;
    return new RegExp(rule.matches, 'i').test(String(value));
  }
  return false;
}

function firstString(raw: JsonRecord, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = valueAtPath(raw, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function laneIsActive(raw: JsonRecord, lane: UnattendedLanePolicy): boolean {
  if (!lane.enabled) return false;

  // Explicit active signals win over stale top-level terminal labels. This matters for
  // lanes such as ASSA ABLOY where an older broad status may coexist with a newer
  // nested measurement-backfill state that is still executable.
  if (lane.active_when_any.some((rule) => signalMatches(raw, rule))) return true;
  if (lane.terminal_when_any.some((rule) => signalMatches(raw, rule))) return false;
  return false;
}

export function summarizeLane(raw: JsonRecord, lane: UnattendedLanePolicy, commit: string): DiscoveredLane {
  const activeStage =
    firstString(raw, [
      'active_stage',
      'lane_state',
      'status',
      'measurement_reconciliation.state',
      'assa_abloy_missing_published_dimension_backfill.state',
      'imagery_execution.state',
    ]) ?? 'ACTIVE_UNATTENDED_EXECUTION';

  const firstUnfinishedTask =
    firstString(raw, [
      'first_unfinished_task',
      'current_action',
      'resume_rule',
      'next_eligible_work_item.work_item_id',
      'measurement_reconciliation.next_measurement_work_item',
    ]) ?? 'Read the governed checkpoint and execute the next authorized unfinished task.';

  return { ...lane, checkpoint_commit: commit, active_stage: activeStage, first_unfinished_task: firstUnfinishedTask };
}

/**
 * Selects a bounded rotating window of active lanes without persistent scheduler state.
 * The GitHub workflow run number is used as the cycle input, so lanes that fail to make
 * progress still rotate out of the next cycle instead of monopolizing execution slots.
 */
export function selectRotatingLanes(
  lanes: DiscoveredLane[],
  maxLanesPerCycle: number,
  schedulerCycle: number,
): DiscoveredLane[] {
  if (!Number.isFinite(maxLanesPerCycle) || maxLanesPerCycle <= 0 || lanes.length <= maxLanesPerCycle) {
    return lanes;
  }

  const width = Math.max(1, Math.floor(maxLanesPerCycle));
  const cycle = Number.isFinite(schedulerCycle) && schedulerCycle >= 0 ? Math.floor(schedulerCycle) : 0;
  const start = (cycle * width) % lanes.length;
  const selected: DiscoveredLane[] = [];

  for (let offset = 0; offset < width; offset += 1) {
    selected.push(lanes[(start + offset) % lanes.length]);
  }

  return selected;
}

export function loadPolicies(path: string): UnattendedLanePolicyDocument {
  return JSON.parse(readFileSync(path, 'utf8')) as UnattendedLanePolicyDocument;
}

export function discoverFromGit(
  policyDocument: UnattendedLanePolicyDocument,
  forceLane?: string,
): DiscoveredLane[] {
  const discovered: DiscoveredLane[] = [];
  for (const lane of policyDocument.lanes) {
    if (forceLane && lane.lane_id !== forceLane) continue;
    if (!lane.enabled) continue;
    try {
      const commit = execFileSync('git', ['rev-parse', `origin/${lane.branch}`], { encoding: 'utf8' }).trim();
      const content = execFileSync(
        'git',
        ['show', `origin/${lane.branch}:${lane.checkpoint_path}`],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      );
      const raw = JSON.parse(content) as JsonRecord;
      if (laneIsActive(raw, lane)) discovered.push(summarizeLane(raw, lane, commit));
    } catch (error) {
      // A missing branch/checkpoint is a controlled discovery miss, not authority to
      // infer replacement work from a neighboring lane.
      console.error(`UNATTENDED_DISCOVERY_SKIP:${lane.lane_id}:${(error as Error).message}`);
    }
  }
  return discovered;
}
