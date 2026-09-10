import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enqueueCheckpoint } from './checkpoint';
import { loadQueue, writeJsonAtomic } from './stateStore';
import { PlatformLimitCheckpoint } from './types';

const checkpointPath = process.argv[2];
if (!checkpointPath) {
  throw new Error('Usage: npm run orchestrator:ingest -- <checkpoint.json> [queue.json]');
}

const queuePath = resolve(process.argv[3] ?? 'oi-orchestration/WORKSTREAM_RESUME_QUEUE.json');
const checkpoint = JSON.parse(readFileSync(resolve(checkpointPath), 'utf8')) as PlatformLimitCheckpoint;
const queue = loadQueue(queuePath);
const before = queue.jobs.length;
const job = enqueueCheckpoint(queue.jobs, checkpoint);
writeJsonAtomic(queuePath, queue);

process.stdout.write(
  `${JSON.stringify(
    {
      job_id: job.job_id,
      resume_id: job.resume_id,
      queue_path: queuePath,
      added: queue.jobs.length > before,
      paid_execution_enabled: queue.paid_execution_enabled,
    },
    null,
    2,
  )}\n`,
);
