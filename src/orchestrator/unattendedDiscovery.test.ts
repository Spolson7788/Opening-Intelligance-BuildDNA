import { describe, expect, it } from 'vitest';
import {
  DiscoveredLane,
  laneIsActive,
  selectRotatingLanes,
  summarizeLane,
  UnattendedLanePolicy,
} from './unattendedDiscovery';

const baseLane: UnattendedLanePolicy = {
  lane_id: 'ASSA_ABLOY',
  enabled: true,
  authorized_manufacturer_group: 'ASSA_ABLOY',
  execution_owner: 'ASSA_ABLOY_LANE',
  branch: 'oi-assa-abloy-evidence',
  checkpoint_path: 'oi-workstreams/assa-abloy/CURRENT_CHECKPOINT.json',
  allowed_write_root: 'oi-workstreams/assa-abloy/',
  active_when_any: [
    { path: 'assa_abloy_missing_published_dimension_backfill.state', matches: '^(IN_PROGRESS|ACTIVE)$' },
    { path: 'imagery_execution.state', matches: '^(IMAGERY_IN_PROGRESS|READY_FOR_IMAGERY|READY_TO_GENERATE)$' },
  ],
  terminal_when_any: [
    { path: 'status', matches: 'NO_ELIGIBLE_AUTHORIZED_(ASSA_ABLOY_)?WORK_REMAINS' },
    { path: 'assa_abloy_missing_published_dimension_backfill.state', matches: '^(CONTROLLED_DEPENDENCIES_ONLY|TERMINAL)$' },
  ],
};

function discoveredLane(id: string): DiscoveredLane {
  return {
    lane_id: id,
    enabled: true,
    authorized_manufacturer_group: id,
    execution_owner: `${id}_LANE`,
    branch: `oi-${id.toLowerCase()}-evidence`,
    checkpoint_path: `oi-workstreams/${id.toLowerCase()}/CURRENT_CHECKPOINT.json`,
    allowed_write_root: `oi-workstreams/${id.toLowerCase()}/`,
    active_when_any: [],
    terminal_when_any: [],
    checkpoint_commit: `${id}-commit`,
    active_stage: 'ACTIVE_NON_IMAGERY_EXECUTION',
    first_unfinished_task: `Continue ${id}`,
  };
}

describe('unattended lane discovery', () => {
  it('lets a newer nested executable state override a stale broad terminal label', () => {
    const raw = {
      status: 'NO_ELIGIBLE_AUTHORIZED_ASSA_ABLOY_WORK_REMAINS_ONLY_EXTERNAL_DEPENDENCY_HOLDS',
      assa_abloy_missing_published_dimension_backfill: { state: 'IN_PROGRESS' },
    };
    expect(laneIsActive(raw, baseLane)).toBe(true);
  });

  it('keeps a truly terminal lane inactive when no explicit active signal exists', () => {
    const raw = { status: 'NO_ELIGIBLE_AUTHORIZED_ASSA_ABLOY_WORK_REMAINS' };
    expect(laneIsActive(raw, baseLane)).toBe(false);
  });

  it('does not mistake a controlled imagery hold for executable imagery', () => {
    const raw = {
      status: 'NO_ELIGIBLE_AUTHORIZED_WORK_REMAINS_ONLY_EXTERNAL_DEPENDENCY_HOLDS',
      imagery_execution: { state: 'IMAGERY_IN_PROGRESS_CONTROLLED_HOLD' },
      assa_abloy_missing_published_dimension_backfill: { state: 'CONTROLLED_DEPENDENCIES_ONLY' },
    };
    expect(laneIsActive(raw, baseLane)).toBe(false);
  });

  it('extracts a deterministic unfinished task for the executor prompt', () => {
    const raw = {
      status: 'READY_TO_RESUME',
      resume_rule: 'Continue the exact next row without repeating prior work.',
    };
    const summary = summarizeLane(raw, { ...baseLane, lane_id: 'TEST' }, 'deadbeef');
    expect(summary.first_unfinished_task).toContain('Continue the exact next row');
    expect(summary.checkpoint_commit).toBe('deadbeef');
  });

  it('sleeps a child lane at an external manufacturer dependency even if status remains ACTIVE', () => {
    const childPolicy: UnattendedLanePolicy = {
      ...baseLane,
      lane_id: 'CORBIN_RUSSWIN',
      authorized_manufacturer_group: 'CORBIN_RUSSWIN',
      execution_owner: 'CORBIN_RUSSWIN_LANE',
      active_when_any: [
        { path: 'lane_state', matches: '^(ACTIVE_NON_IMAGERY_EXECUTION|IN_PROGRESS|ACTIVE)$' },
        { path: 'known_uncaptured_published_dimensions', matches: '^(GREATER_THAN_ZERO|[1-9][0-9]*)$' },
      ],
      terminal_when_any: [
        { path: 'status', matches: 'NO_ELIGIBLE_AUTHORIZED_CORBIN_RUSSWIN_WORK_REMAINS|TERMINAL' },
      ],
    };

    expect(laneIsActive({
      status: 'ACTIVE',
      lane_state: 'ACTIVE_EXTERNAL_MANUFACTURER_DEPENDENCY',
      known_uncaptured_published_dimensions: 'UNRESOLVED_EXTERNAL_SOURCE_DEPENDENCIES_NOT_ZERO_CERTIFIED',
    }, childPolicy)).toBe(false);

    expect(laneIsActive({
      status: 'ACTIVE',
      lane_state: 'ACTIVE_NON_IMAGERY_EXECUTION',
    }, childPolicy)).toBe(true);
  });
});

describe('rotating unattended scheduler selection', () => {
  it('selects a bounded window and wraps across cycles', () => {
    const lanes = ['A', 'B', 'C', 'D', 'E'].map(discoveredLane);
    expect(selectRotatingLanes(lanes, 3, 0).map((item) => item.lane_id)).toEqual(['A', 'B', 'C']);
    expect(selectRotatingLanes(lanes, 3, 1).map((item) => item.lane_id)).toEqual(['D', 'E', 'A']);
    expect(selectRotatingLanes(lanes, 3, 2).map((item) => item.lane_id)).toEqual(['B', 'C', 'D']);
  });

  it('rotates fairly with the production two-slot concurrency cap', () => {
    const lanes = ['A', 'B', 'C', 'D', 'E'].map(discoveredLane);
    expect(selectRotatingLanes(lanes, 2, 0).map((item) => item.lane_id)).toEqual(['A', 'B']);
    expect(selectRotatingLanes(lanes, 2, 1).map((item) => item.lane_id)).toEqual(['C', 'D']);
    expect(selectRotatingLanes(lanes, 2, 2).map((item) => item.lane_id)).toEqual(['E', 'A']);
    expect(selectRotatingLanes(lanes, 2, 3).map((item) => item.lane_id)).toEqual(['B', 'C']);
  });

  it('returns the full active set when it fits within the cycle cap', () => {
    const lanes = ['A', 'B'].map(discoveredLane);
    expect(selectRotatingLanes(lanes, 3, 99).map((item) => item.lane_id)).toEqual(['A', 'B']);
  });
});