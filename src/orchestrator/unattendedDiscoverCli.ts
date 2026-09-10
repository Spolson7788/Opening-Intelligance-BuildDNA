import { appendFileSync } from 'node:fs';
import { discoverFromGit, loadPolicies, selectRotatingLanes } from './unattendedDiscovery';

const policyPath = process.argv[2] ?? 'oi-orchestration/UNATTENDED_LANES.json';
const forceLane = process.env.OI_FORCE_LANE?.trim() || undefined;
const maxLanesPerCycle = Number.parseInt(process.env.OI_MAX_LANES_PER_CYCLE ?? '0', 10);
const schedulerCycle = Number.parseInt(process.env.OI_SCHEDULER_CYCLE ?? '0', 10);
const policies = loadPolicies(policyPath);
const discoveredLanes = discoverFromGit(policies, forceLane);
const lanes = forceLane
  ? discoveredLanes
  : selectRotatingLanes(discoveredLanes, maxLanesPerCycle, schedulerCycle);
const matrix = JSON.stringify({ include: lanes });
const selectedLaneIds = lanes.map((lane) => lane.lane_id).join(',');

console.log(JSON.stringify({
  total_active_lane_count: discoveredLanes.length,
  selected_active_lane_count: lanes.length,
  scheduler_cycle: schedulerCycle,
  max_lanes_per_cycle: maxLanesPerCycle,
  selected_lane_ids: lanes.map((lane) => lane.lane_id),
  lanes,
}, null, 2));

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  appendFileSync(githubOutput, `matrix=${matrix}\n`);
  appendFileSync(githubOutput, `active_lane_count=${lanes.length}\n`);
  appendFileSync(githubOutput, `total_active_lane_count=${discoveredLanes.length}\n`);
  appendFileSync(githubOutput, `selected_lane_ids=${selectedLaneIds}\n`);
  appendFileSync(githubOutput, `scheduler_cycle=${schedulerCycle}\n`);
}
