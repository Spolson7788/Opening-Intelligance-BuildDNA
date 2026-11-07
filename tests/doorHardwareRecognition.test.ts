import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { enforceRolePermissions } from '../src/middleware/permissions';
import { sha256Hex } from '../src/services/recognitionRuns';
import {
  DOOR_HARDWARE_WORKFLOW_URL,
  type ConfirmationPlan,
  type DoorHardwareStore,
  type HardwareItem,
  type RunPhoto,
  type StoredItem,
  type StoredRun,
  compressForWorkflow,
  executeConfirm,
  executeIdentify,
  mapHardwareType,
  parseCombinedHardware,
  photoCountError,
  planConfirmation,
  resolveDailyLimit,
  takeCombinedHardware,
  validateIdentifyRequest,
  workflowRequestBytes,
  WORKFLOW_REQUEST_BYTE_BUDGET,
} from '../src/services/doorHardwareRecognition';

const KEY = 'unit-test-roboflow-key';
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OPENING = '33333333-3333-4333-8333-333333333333';

function picture(n: number) {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, n, 0xff, 0xd9]);
  return { id: randomUUID(), key: `photo-${n}`, bytes, sha: sha256Hex(bytes) };
}

function memoryStore(options?: { area?: boolean; opening?: boolean }) {
  const photos = new Map<string, RunPhoto & { bytes: Uint8Array }>();
  const runs = new Map<string, StoredRun>();
  const byRequest = new Map<string, string>();
  const labels: ConfirmationPlan['labels'] = [];
  let used = 0;
  let confirmCalls = 0;
  const calls = { fetch: 0, read: 0 };
  const store: DoorHardwareStore = {
    async findOpening() {
      return options?.opening === false ? null : { id: OPENING, property_id: '44444444-4444-4444-8444-444444444444' };
    },
    async areaAllows() { return options?.area !== false; },
    async findRunByRequest(userId, clientRequestId) {
      const id = byRequest.get(`${userId}:${clientRequestId}`);
      const run = id ? runs.get(id) : undefined;
      return run ? { id: run.id, organization_id: run.organization_id, opening_id: run.opening_id } : null;
    },
    async findRun(_orgId, runId) { return runs.get(runId) ?? null; },
    async loadPhotos(_org, _opening, ids) { return ids.map((id) => photos.get(id)).filter((row): row is RunPhoto & { bytes: Uint8Array } => Boolean(row)); },
    async readBytes(key) {
      calls.read++;
      const row = [...photos.values()].find((photo) => photo.storage_object_key === key);
      if (!row) throw new Error('object_missing');
      return row.bytes;
    },
    async orgDailyLimit() { return null; },
    async consumeDailyRun(_org, limit) {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    async insertRun(row) {
      const id = randomUUID();
      const run: StoredRun = {
        id, organization_id: row.organizationId, property_id: row.propertyId, opening_id: row.openingId,
        requested_by_user_id: row.userId, client_request_id: row.clientRequestId, status: 'running', failure_code: null,
        photo_count: row.photoCount, items: [], photos: [],
      };
      runs.set(id, run);
      byRequest.set(`${row.userId}:${row.clientRequestId}`, id);
      return { id, created: true };
    },
    async attachPhotos(runId, rows) {
      const run = runs.get(runId)!;
      run.photos = rows.map((row) => ({ photo_id: row.photoId, ordinal: row.ordinal }));
    },
    async finishRun(runId, patch) {
      const run = runs.get(runId)!;
      if (run.status !== 'running') return;
      run.status = patch.status;
      run.failure_code = patch.failure_code ?? null;
    },
    async insertItems(runId, items) {
      const run = runs.get(runId)!;
      run.items = items.map((item, index): StoredItem => ({ ...item, id: randomUUID(), ordinal: index + 1, review_state: 'pending', hardware_component_id: null }));
    },
    async confirm(_actor, runId, plan) {
      confirmCalls += 1;
      const run = runs.get(runId)!;
      if (run.status === 'confirmed') return { already: true, hardware: [], training_labels: 0 };
      run.status = 'confirmed';
      const hardware = plan.hardware.map((part) => {
        const id = randomUUID();
        const item = run.items.find((row) => row.id === part.itemId);
        if (item) { item.review_state = 'confirmed'; item.hardware_component_id = id; item.exact_model = part.model_number; }
        return { id, tracker_id: 'TRK-TEST0001', component_type: part.component_type };
      });
      for (const update of plan.itemUpdates) {
        const item = run.items.find((row) => row.id === update.itemId);
        if (item && update.review_state === 'dismissed') item.review_state = 'dismissed';
      }
      labels.push(...plan.labels);
      return { already: false, hardware, training_labels: plan.labels.length };
    },
  };
  return { store, photos, runs, labels, calls, confirmCalls: () => confirmCalls, add(n: number, checksum?: string) {
    const shot = picture(n);
    const row = { id: shot.id, sha256_checksum: checksum ?? shot.sha, storage_object_key: shot.key, content_type: 'image/jpeg', bytes: shot.bytes };
    photos.set(shot.id, row);
    return row;
  } };
}

function combined(items: unknown[], echoes = 3) {
  return JSON.stringify({
    outputs: Array.from({ length: echoes }, (_, index) => ({
      combined_hardware: JSON.stringify({ items: index === 0 ? items : [{ hardware_type: 'not-this', exact_model: 'WRONG' }] }),
      annotated_image: { type: 'base64', value: 'ANNOTATED_IMAGE_BYTES' },
    })),
  });
}

const closer = { hardware_type: 'door closer', subtype: 'surface', manufacturer: 'LCN', exact_model: '4040XP', finish: '689', supporting_photos: [1, 3], visible_evidence: 'LCN 4040XP on the closer body', confidence: 'high', next_photo: 'not needed' };
const lock = { hardware_type: 'mortise lock', subtype: null, manufacturer: 'Schlage', exact_model: 'unknown', finish: '626', supporting_photos: ['2'], visible_evidence: 'No model line', confidence: 'sky-high', next_photo: 'Photograph the lock label' };

describe('door hardware recognition parsing', () => {
  it('parses the combined JSON string and drops an unknown model word', () => {
    const parsed = parseCombinedHardware(JSON.stringify({ items: [closer, lock] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items.map((item) => item.component_type)).toEqual(['closer', 'lockset']);
    expect(parsed.items[0]).toMatchObject({ manufacturer: 'LCN', exact_model: '4040XP', model_unknown: false, confidence: 'high', supporting_photos: [1, 3] });
    expect(parsed.items[1]).toMatchObject({ exact_model: null, model_unknown: true, confidence: null, next_photo: 'Photograph the lock label', supporting_photos: [2] });
  });

  it('accepts a fenced or prefixed JSON string', () => {
    expect(parseCombinedHardware('```json\n{"items":[{"hardware_type":"hinge","exact_model":"A"}]}\n```').ok).toBe(true);
    const salvaged = parseCombinedHardware('note {"items":[{"hardware_type":"cylinder","exact_model":"C"}]} trailing');
    expect(salvaged.ok && salvaged.items[0].component_type).toBe('cylinder');
  });

  it('rejects invalid JSON', () => {
    expect(parseCombinedHardware('{not json').ok).toBe(false);
    expect(parseCombinedHardware('{"hardware":[]}').ok).toBe(false);
    expect(parseCombinedHardware(null).ok).toBe(false);
  });

  it('uses output element 0 and does not keep annotated images', () => {
    const taken = takeCombinedHardware(JSON.parse(combined([closer], 4)));
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.echoes).toBe(4);
    expect(String(taken.raw)).toContain('4040XP');
    expect(String(taken.raw)).not.toContain('WRONG');
    expect(JSON.stringify(taken)).not.toContain('ANNOTATED_IMAGE_BYTES');
  });
});

describe('door hardware type mapping and limits', () => {
  it('maps known hardware onto OI types and falls back to other', () => {
    expect(mapHardwareType('panic bar')).toBe('panic_bar');
    expect(mapHardwareType('Mag Lock')).toBe('maglock');
    expect(mapHardwareType('electric_strike')).toBe('electric_strike');
    expect(mapHardwareType('card reader')).toBe('access_control_reader');
    expect(mapHardwareType('continuous hinge')).toBe('hinge');
    expect(mapHardwareType('weatherstrip')).toBe('other');
    expect(mapHardwareType(null)).toBe('other');
    expect(mapHardwareType('')).toBe('other');
  });

  it('enforces 3 to 9 photographs and a configurable daily run limit', () => {
    expect(photoCountError(2)).toBe('too_few_photos');
    expect(photoCountError(3)).toBeNull();
    expect(photoCountError(9)).toBeNull();
    expect(photoCountError(10)).toBe('too_many_photos');
    expect(resolveDailyLimit({}, null)).toBe(50);
    expect(resolveDailyLimit({ HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '12' }, null)).toBe(12);
    expect(resolveDailyLimit({ HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: 'nope' }, null)).toBe(50);
    expect(resolveDailyLimit({ HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '12' }, 0)).toBe(0);
    expect(resolveDailyLimit({}, 7)).toBe(7);
  });

  it('rejects a browser-supplied API key and the wrong photograph counts', () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    expect(validateIdentifyRequest({ opening_id: OPENING, photo_ids: ids, client_request_id: randomUUID(), api_key: 'nope' }).ok).toBe(false);
    expect(validateIdentifyRequest({ opening_id: OPENING, photo_ids: ids.slice(0, 2), client_request_id: randomUUID() })).toMatchObject({ ok: false, error: 'too_few_photos' });
    expect(validateIdentifyRequest({ opening_id: OPENING, photo_ids: Array.from({ length: 10 }, () => randomUUID()), client_request_id: randomUUID() })).toMatchObject({ ok: false, error: 'too_many_photos' });
    expect(validateIdentifyRequest({ opening_id: OPENING, photo_ids: [ids[0], ids[0], ids[1]], client_request_id: randomUUID() })).toMatchObject({ ok: false, error: 'duplicate_photo' });
  });

  it('compresses only when the workflow request would exceed the budget', async () => {
    let resized = 0;
    const sharp = () => ({
      rotate() { return this; },
      resize() { resized += 1; return this; },
      jpeg() { return this; },
      async toBuffer() { return Buffer.from('small'); },
    });
    const tiny = await compressForWorkflow([new Uint8Array([1, 2, 3]), new Uint8Array([4])], { sharp: sharp as any });
    expect(resized).toBe(0);
    expect(tiny.images).toHaveLength(2);
    const big = new Uint8Array(900_000);
    const fitted = await compressForWorkflow([big, big, big], { sharp: sharp as any, budget: 2_000, apiKeyLength: 8 });
    expect(resized).toBe(3);
    expect(fitted.images).toHaveLength(3);
    expect(workflowRequestBytes(fitted.images.map((image) => image.value), 8)).toBeLessThanOrEqual(2_000);
    await expect(compressForWorkflow([big], { sharp: (() => ({ rotate() { return this; }, resize() { return this; }, jpeg() { return this; }, toBuffer: async () => Buffer.alloc(5_000) })) as any, budget: 100, apiKeyLength: 4 })).rejects.toThrow('photos_exceed_provider_limit');
    expect(WORKFLOW_REQUEST_BYTE_BUDGET).toBeLessThan(20 * 1024 * 1024);
  });
});

describe('door hardware recognition run', () => {
  const env = { ROBOFLOW_API_KEY: KEY, HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '1' };

  function stage() {
    const mem = memoryStore();
    const shots = [mem.add(1), mem.add(2), mem.add(3)];
    const bodies: any[] = [];
    let script: (() => { status: number; text: () => Promise<string> })[] = [];
    const fetchImpl = async (url: string, init: { method: string; body: string }) => {
      callsFetch();
      expect(url).toBe(DOOR_HARDWARE_WORKFLOW_URL);
      expect(init.method).toBe('POST');
      bodies.push(JSON.parse(init.body));
      const next = script.shift();
      if (!next) throw new Error('unexpected_provider_call');
      return next();
    };
    let fetchCount = 0;
    const callsFetch = () => { fetchCount += 1; };
    return { mem, shots, bodies, fetchImpl, setScript(next: typeof script) { script = [...next]; }, fetchCount: () => fetchCount };
  }

  let staged: ReturnType<typeof stage>;
  beforeEach(() => { staged = stage(); });

  function ok(items: unknown[]) {
    return () => ({ status: 200, text: async () => combined(items) });
  }

  it('sends every photograph in one request and keeps the first combined result', async () => {
    staged.setScript([ok([closer, lock])]);
    const outcome = await executeIdentify(
      { organizationId: ORG, userId: USER },
      { openingId: OPENING, photoIds: staged.shots.map((shot) => shot.id), clientRequestId: randomUUID() },
      { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env },
    );
    expect(outcome.httpStatus).toBe(201);
    expect(staged.fetchCount()).toBe(1);
    expect(staged.bodies[0].api_key).toBe(KEY);
    expect(staged.bodies[0].inputs.images).toHaveLength(3);
    expect(staged.bodies[0].inputs.images.every((image: { type: string; value: string }) => image.type === 'base64' && image.value.length > 0)).toBe(true);
    const items = (outcome.body.run as { items: HardwareItem[] }).items;
    expect(items.map((item) => item.component_type)).toEqual(['closer', 'lockset']);
    expect(items[1].model_unknown).toBe(true);
    expect(items[1].next_photo).toBe('Photograph the lock label');
    const encoded = JSON.stringify(outcome.body);
    expect(encoded).not.toContain('ANNOTATED_IMAGE_BYTES');
    expect(encoded).not.toContain(KEY);
    expect(encoded).not.toContain('WRONG');
  });

  it('retries once when the combined JSON is invalid, then stops', async () => {
    staged.setScript([
      () => ({ status: 200, text: async () => JSON.stringify({ outputs: [{ combined_hardware: '{bad', annotated_image: { value: 'ANNOTATED_IMAGE_BYTES' } }, { combined_hardware: '{also bad' }] }) }),
      ok([closer]),
    ]);
    const first = await executeIdentify(
      { organizationId: ORG, userId: USER },
      { openingId: OPENING, photoIds: staged.shots.map((shot) => shot.id), clientRequestId: randomUUID() },
      { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env: { ...env, HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '5' } },
    );
    expect(staged.fetchCount()).toBe(2);
    expect(first.httpStatus).toBe(201);
    expect(JSON.stringify(first.body)).not.toContain('ANNOTATED_IMAGE_BYTES');

    staged.setScript([
      () => ({ status: 200, text: async () => 'not-json' }),
      () => ({ status: 200, text: async () => JSON.stringify({ outputs: [{ combined_hardware: '{"nope":true}' }] }) }),
    ]);
    const second = await executeIdentify(
      { organizationId: ORG, userId: USER },
      { openingId: OPENING, photoIds: staged.shots.map((shot) => shot.id), clientRequestId: randomUUID() },
      { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env: { ...env, HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '5' } },
    );
    expect(second.httpStatus).toBe(502);
    expect(second.body.error).toBe('provider_result_unreadable');
    expect(staged.fetchCount()).toBe(4);
  });

  it('does not call Roboflow when the daily limit, area, or opening check fails', async () => {
    staged.setScript([ok([closer])]);
    const actor = { organizationId: ORG, userId: USER };
    const photos = staged.shots.map((shot) => shot.id);
    const first = await executeIdentify(actor, { openingId: OPENING, photoIds: photos, clientRequestId: randomUUID() }, { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env });
    expect(first.httpStatus).toBe(201);
    const capped = await executeIdentify(actor, { openingId: OPENING, photoIds: photos, clientRequestId: randomUUID() }, { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env });
    expect(capped.httpStatus).toBe(429);
    expect(capped.body.error).toBe('daily_limit_exceeded');
    expect(staged.fetchCount()).toBe(1);

    const blocked = memoryStore({ area: false });
    const shot = blocked.add(9);
    const denied = await executeIdentify(actor, { openingId: OPENING, photoIds: [shot.id, blocked.add(8).id, blocked.add(7).id], clientRequestId: randomUUID() }, { store: blocked.store, fetchImpl: staged.fetchImpl as any, env });
    expect(denied).toMatchObject({ httpStatus: 403, body: { error: 'forbidden' } });

    const missing = memoryStore({ opening: false });
    const absent = await executeIdentify(actor, { openingId: OPENING, photoIds: photos, clientRequestId: randomUUID() }, { store: missing.store, fetchImpl: staged.fetchImpl as any, env });
    expect(absent).toMatchObject({ httpStatus: 404, body: { error: 'opening_not_found' } });
    expect(staged.fetchCount()).toBe(1);
  });

  it('replays the same request without a second provider call', async () => {
    staged.setScript([ok([lock])]);
    const requestId = randomUUID();
    const input = { openingId: OPENING, photoIds: staged.shots.map((shot) => shot.id), clientRequestId: requestId };
    const deps = { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env: { ...env, HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '5' } };
    expect((await executeIdentify({ organizationId: ORG, userId: USER }, input, deps)).httpStatus).toBe(201);
    const replay = await executeIdentify({ organizationId: ORG, userId: USER }, input, deps);
    expect(replay).toMatchObject({ httpStatus: 200, body: { replayed: true } });
    expect(staged.fetchCount()).toBe(1);
  });

  it('saves training labels for confirmed photographs and skips a dismissed item', async () => {
    staged.setScript([ok([closer, lock])]);
    const actor = { organizationId: ORG, userId: USER };
    const created = await executeIdentify(actor, { openingId: OPENING, photoIds: staged.shots.map((shot) => shot.id), clientRequestId: randomUUID() }, { store: staged.mem.store, fetchImpl: staged.fetchImpl as any, env: { ...env, HARDWARE_RECOGNITION_DAILY_RUN_LIMIT: '5' } });
    const run = created.body.run as StoredRun;
    const saved = await executeConfirm(actor, run.id, [
      { id: run.items[0].id, include: true, component_type: 'closer', manufacturer: 'LCN', model_number: '4040XP', finish: '689', subtype: 'surface' },
      { id: run.items[1].id, include: false, component_type: 'lockset', manufacturer: 'Schlage', model_number: null, finish: null, subtype: null },
    ], staged.mem.store);
    expect(saved.httpStatus).toBe(200);
    expect(saved.body.training_labels).toBe(2);
    expect(staged.mem.labels.map((label) => label.photoOrdinal).sort()).toEqual([1, 3]);
    expect(staged.mem.labels.every((label) => label.component_type === 'closer' && label.model_number === '4040XP')).toBe(true);
    const again = await executeConfirm(actor, run.id, [], staged.mem.store);
    expect(again).toMatchObject({ httpStatus: 200, body: { replayed: true } });
    expect(staged.mem.confirmCalls()).toBe(1);
    const bad = planConfirmation(staged.mem.runs.get(run.id)!, [
      { id: run.items[0].id, include: true, component_type: 'weatherstrip' },
      { id: run.items[1].id, include: false, component_type: 'lockset' },
    ]);
    expect(bad).toMatchObject({ ok: false, error: 'invalid_component_type' });
  });
});

describe('door hardware recognition permissions', () => {
  function decide(role: string, method: string, path: string) {
    let status = 0;
    const req: any = { auth: { userId: USER, organizationId: ORG, role }, method, originalUrl: path, body: {} };
    const res: any = { status(code: number) { status = code; return this; }, json() { return this; } };
    enforceRolePermissions(req, res, () => { status = 200; });
    return status;
  }

  it('lets technicians identify and confirm, and keeps inspectors and viewers from writing', () => {
    expect(decide('technician', 'POST', '/api/hardware-recognition/runs')).toBe(200);
    expect(decide('technician', 'POST', `/api/hardware-recognition/runs/${randomUUID()}/confirm`)).toBe(200);
    expect(decide('facilities_manager', 'POST', '/api/hardware-recognition/runs')).toBe(200);
    expect(decide('admin', 'POST', '/api/hardware-recognition/runs')).toBe(200);
    expect(decide('inspector', 'POST', '/api/hardware-recognition/runs')).toBe(403);
    expect(decide('inspector', 'POST', '/api/hardware-recognition/runs/abc/confirm')).toBe(403);
    expect(decide('viewer', 'POST', '/api/hardware-recognition/runs')).toBe(403);
    expect(decide('viewer', 'GET', '/api/hardware-recognition/runs/abc')).toBe(200);
    expect(decide('inspector', 'GET', '/api/hardware-recognition/runs/abc')).toBe(200);
  });
});

describe('door hardware recognition migration', () => {
  it('declares the training set, row security, and a browser-role revoke', () => {
    const sql = readFileSync('migrations/20261107203000_door_hardware_recognition.sql', 'utf8');
    expect(sql).toContain('hardware_training_labels');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toMatch(/REVOKE ALL ON %s FROM %s/);
    expect(sql).toContain("'anon', 'authenticated'");
    expect(sql).not.toMatch(/fadihkhdwpfffpelqjtg|ytqiulxtiharrplqnuir|fdudsigbxumcpbxxxerb|ioqfdcehnhnqpnqawwvo|bekaxmatcvxqpjixwsqn|boaoedvyvifppuklbwad/);
    const rollback = readFileSync('docs/rollback/20261107203000_door_hardware_recognition_rollback.sql', 'utf8');
    expect(rollback).toContain('DROP TABLE IF EXISTS hardware_training_labels');
  });

  it('applies on a database that already has the referenced tables', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE ROLE oi_pr2_api NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE properties (id uuid PRIMARY KEY);
      CREATE TABLE openings (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE photos (id uuid PRIMARY KEY);
      CREATE TABLE hardware_components (id uuid PRIMARY KEY);
    `);
    await db.exec(readFileSync('migrations/20261107203000_door_hardware_recognition.sql', 'utf8'));
    const names = (await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relname LIKE 'hardware_recognition%' OR relname = 'hardware_training_labels' ORDER BY relname`,
    )).rows;
    expect(names.map((row) => row.relname)).toEqual([
      'hardware_recognition_daily_usage', 'hardware_recognition_items', 'hardware_recognition_run_photos',
      'hardware_recognition_runs', 'hardware_recognition_settings', 'hardware_training_labels',
    ]);
    expect(names.every((row) => row.relrowsecurity)).toBe(true);
    const org = randomUUID();
    const property = randomUUID();
    const opening = randomUUID();
    const user = randomUUID();
    await db.query('INSERT INTO organizations (id) VALUES ($1)', [org]);
    await db.query('INSERT INTO properties (id) VALUES ($1)', [property]);
    await db.query('INSERT INTO openings (id) VALUES ($1)', [opening]);
    await db.query('INSERT INTO users (id) VALUES ($1)', [user]);
    const reserved = await db.query(
      `WITH attempt AS (
         INSERT INTO hardware_recognition_daily_usage (organization_id, run_day, run_count)
         SELECT $1, (timezone('utc', now()))::date, 1
         WHERE $2::int >= 1
         ON CONFLICT (organization_id, run_day)
         DO UPDATE SET run_count = hardware_recognition_daily_usage.run_count + 1
         WHERE hardware_recognition_daily_usage.run_count < $2::int
         RETURNING run_count
       ) SELECT run_count FROM attempt`,
      [org, 1],
    );
    expect(reserved.rows[0].run_count).toBe(1);
    const blocked = await db.query(
      `WITH attempt AS (
         INSERT INTO hardware_recognition_daily_usage (organization_id, run_day, run_count)
         SELECT $1, (timezone('utc', now()))::date, 1
         WHERE $2::int >= 1
         ON CONFLICT (organization_id, run_day)
         DO UPDATE SET run_count = hardware_recognition_daily_usage.run_count + 1
         WHERE hardware_recognition_daily_usage.run_count < $2::int
         RETURNING run_count
       ) SELECT run_count FROM attempt`,
      [org, 1],
    );
    expect(blocked.rows).toEqual([]);
    const requestId = randomUUID();
    await db.query(
      `INSERT INTO hardware_recognition_runs
         (organization_id, property_id, opening_id, requested_by_user_id, client_request_id, status, photo_count)
       VALUES ($1,$2,$3,$4,$5,'running',3)`,
      [org, property, opening, user, requestId],
    );
    for (const role of ['anon', 'authenticated']) {
      const privilege = (await db.query<{ p: boolean }>(
        `SELECT has_table_privilege($1, 'hardware_training_labels', 'SELECT,INSERT,UPDATE,DELETE') p`,
        [role],
      )).rows[0].p;
      expect(privilege).toBe(false);
    }
    expect((await db.query<{ p: boolean }>(`SELECT has_table_privilege('oi_pr2_api', 'hardware_recognition_runs', 'SELECT,INSERT,UPDATE') p`)).rows[0].p).toBe(true);
  });
});
