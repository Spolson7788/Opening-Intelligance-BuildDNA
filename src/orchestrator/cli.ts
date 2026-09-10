import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runDryResumeSimulation } from './dryRun';
import { PlatformLimitCheckpoint } from './types';

function loadCheckpoint(pathArg?: string): PlatformLimitCheckpoint {
  const path = resolve(pathArg ?? 'oi-orchestration/examples/platform-limit-checkpoint.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PlatformLimitCheckpoint;
}

const checkpoint = loadCheckpoint(process.argv[2]);
const result = runDryResumeSimulation({
  checkpoint,
  executor_id: process.env.OI_EXECUTOR_ID ?? 'dry-run-executor',
  executor_scope: process.env.OI_EXECUTOR_SCOPE ?? checkpoint.authorized_manufacturer_group,
  simulated_completed_task_key: checkpoint.first_unfinished_task,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
