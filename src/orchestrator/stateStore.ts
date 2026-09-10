import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  ClaimsDocument,
  ExecutionAuditEvent,
  HeartbeatsDocument,
  QueueDocument,
} from './types';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadQueue(path: string): QueueDocument {
  return readJson<QueueDocument>(path);
}

export function loadClaims(path: string): ClaimsDocument {
  return readJson<ClaimsDocument>(path);
}

export function loadHeartbeats(path: string): HeartbeatsDocument {
  return readJson<HeartbeatsDocument>(path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

export function appendAuditEvent(path: string, event: ExecutionAuditEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}
