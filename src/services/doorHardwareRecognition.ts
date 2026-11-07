import { sha256Hex } from './recognitionRuns';

// Door-hardware identification. The Roboflow API key stays on the server.
// One published-workflow request carries every photograph for the run.
export const DOOR_HARDWARE_WORKFLOW_URL =
  'https://serverless.roboflow.com/stephan-o-s-workspace-td3d7/workflows/oi-door-hardware-recognition';
export const MIN_HARDWARE_PHOTOS = 3;
export const MAX_HARDWARE_PHOTOS = 9;
export const DEFAULT_DAILY_RUN_LIMIT_PER_TECH = 40;
// Stay under the serverless 20 MB request cap, including JSON and the key.
export const WORKFLOW_REQUEST_BYTE_BUDGET = 18 * 1024 * 1024;

export const OI_COMPONENT_TYPES = [
  'lockset', 'cylinder', 'closer', 'exit_device', 'hinge',
  'automatic_operator', 'panic_bar', 'access_control_reader',
  'keypad', 'electric_strike', 'power_transfer', 'maglock',
  'request_to_exit_device', 'other',
] as const;
export type ComponentType = (typeof OI_COMPONENT_TYPES)[number];

const ALIASES: Record<string, ComponentType> = {
  lock: 'lockset',
  'mortise lock': 'lockset',
  'cylindrical lock': 'lockset',
  'lever lock': 'lockset',
  lever: 'lockset',
  'mortise cylinder': 'cylinder',
  'key cylinder': 'cylinder',
  'door closer': 'closer',
  'surface closer': 'closer',
  'exit device': 'exit_device',
  'exit hardware': 'exit_device',
  panic: 'panic_bar',
  'panic bar': 'panic_bar',
  'panic device': 'panic_bar',
  'panic hardware': 'panic_bar',
  hinges: 'hinge',
  'continuous hinge': 'hinge',
  'butt hinge': 'hinge',
  operator: 'automatic_operator',
  'door operator': 'automatic_operator',
  'automatic operator': 'automatic_operator',
  reader: 'access_control_reader',
  'card reader': 'access_control_reader',
  'access control reader': 'access_control_reader',
  'electric strike': 'electric_strike',
  strike: 'electric_strike',
  'power transfer': 'power_transfer',
  'door loop': 'power_transfer',
  'mag lock': 'maglock',
  'magnetic lock': 'maglock',
  'request to exit': 'request_to_exit_device',
  'request to exit device': 'request_to_exit_device',
  rex: 'request_to_exit_device',
  'rex device': 'request_to_exit_device',
};

const UNKNOWN_MODEL = new Set(['unknown', 'unidentified', 'n/a', 'na', 'none', 'not visible', 'not_visible', 'null']);
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type HardwareItem = {
  hardware_type: string;
  component_type: ComponentType;
  subtype: string | null;
  manufacturer: string | null;
  exact_model: string | null;
  finish: string | null;
  supporting_photos: number[];
  visible_evidence: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  next_photo: string | null;
  model_unknown: boolean;
};

export type StoredItem = HardwareItem & {
  id: string;
  ordinal: number;
  review_state: 'pending' | 'confirmed' | 'dismissed';
  hardware_component_id: string | null;
};

export type StoredRun = {
  id: string;
  organization_id: string;
  property_id: string;
  opening_id: string;
  requested_by_user_id: string;
  client_request_id: string;
  status: string;
  failure_code: string | null;
  photo_count: number;
  items: StoredItem[];
  photos: { photo_id: string; ordinal: number }[];
};

export type RunPhoto = {
  id: string;
  sha256_checksum: string;
  storage_object_key: string;
  content_type: string;
};

export type WorkflowImage = { type: 'base64'; value: string };

export interface DoorHardwareStore {
  findOpening(orgId: string, openingId: string): Promise<{ id: string; property_id: string } | null>;
  areaAllows(userId: string, openingId: string): Promise<boolean>;
  findRunByRequest(userId: string, clientRequestId: string): Promise<{ id: string; organization_id: string; opening_id: string } | null>;
  findRun(orgId: string, runId: string): Promise<StoredRun | null>;
  loadPhotos(orgId: string, openingId: string, photoIds: string[]): Promise<RunPhoto[]>;
  readBytes(key: string): Promise<Uint8Array>;
  orgDailyLimit(orgId: string): Promise<number | null>;
  consumeDailyRun(orgId: string, userId: string, techLimit: number, companyLimit: number | null): Promise<boolean>;
  insertRun(row: { organizationId: string; propertyId: string; openingId: string; userId: string; clientRequestId: string; photoCount: number }): Promise<{ id: string; created: boolean }>;
  attachPhotos(runId: string, photos: { photoId: string; ordinal: number; sha256: string; sentBytes: number }[]): Promise<void>;
  finishRun(runId: string, patch: { status: string; failure_code?: string | null; result?: unknown; provider_called: boolean }): Promise<void>;
  insertItems(runId: string, items: HardwareItem[]): Promise<void>;
  confirm(actor: { organizationId: string; userId: string }, runId: string, plan: ConfirmationPlan): Promise<{ already: boolean; hardware: { id: string; tracker_id: string; component_type: string }[]; training_labels: number }>;
}

export type Outcome = { httpStatus: number; body: Record<string, unknown> };

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

export function mapHardwareType(raw: unknown): ComponentType {
  if (typeof raw !== 'string') return 'other';
  const spaced = raw.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!spaced) return 'other';
  const underscored = spaced.replace(/ /g, '_');
  if ((OI_COMPONENT_TYPES as readonly string[]).includes(underscored)) return underscored as ComponentType;
  return ALIASES[spaced] ?? 'other';
}

export function modelIsUnknown(exact: string | null): boolean {
  if (!exact) return true;
  return UNKNOWN_MODEL.has(exact.trim().toLowerCase());
}

function photoNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const n = typeof entry === 'number' ? entry : typeof entry === 'string' && /^\d+$/.test(entry) ? Number(entry) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= MAX_HARDWARE_PHOTOS && !out.includes(n)) out.push(n);
  }
  return out;
}

function confidenceOf(value: unknown): HardwareItem['confidence'] {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : null;
}

export function parseJsonLenient(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* salvage the first object */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

export function parseCombinedHardware(raw: unknown): { ok: true; items: HardwareItem[] } | { ok: false; reason: 'invalid_json' } {
  let value = raw;
  if (typeof raw === 'string') value = parseJsonLenient(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid_json' };
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return { ok: false, reason: 'invalid_json' };
  const parsed: HardwareItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const exact = text(row.exact_model, 200);
    const unknown = modelIsUnknown(exact);
    parsed.push({
      hardware_type: text(row.hardware_type, 80) ?? 'other',
      component_type: mapHardwareType(row.hardware_type),
      subtype: text(row.subtype, 200),
      manufacturer: text(row.manufacturer, 200),
      exact_model: unknown ? null : exact,
      finish: text(row.finish, 80),
      supporting_photos: photoNumbers(row.supporting_photos),
      visible_evidence: text(row.visible_evidence, 2000),
      confidence: confidenceOf(row.confidence),
      next_photo: text(row.next_photo, 500),
      model_unknown: unknown,
    });
  }
  return { ok: true, items: parsed };
}

/** The workflow repeats the combined result once per photo. Use element 0 and drop annotated images. */
export function takeCombinedHardware(body: unknown): { ok: true; raw: unknown; echoes: number } | { ok: false } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const outputs = (body as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return { ok: false };
  const first = outputs[0];
  if (!first || typeof first !== 'object' || Array.isArray(first) || !('combined_hardware' in first)) return { ok: false };
  return { ok: true, raw: (first as { combined_hardware: unknown }).combined_hardware, echoes: outputs.length };
}

export function photoCountError(count: number): 'too_few_photos' | 'too_many_photos' | null {
  if (count < MIN_HARDWARE_PHOTOS) return 'too_few_photos';
  if (count > MAX_HARDWARE_PHOTOS) return 'too_many_photos';
  return null;
}

/** Per-technician runs per UTC day. A missing or invalid env value uses the default. */
export function resolveTechDailyLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.HARDWARE_RECOGNITION_DAILY_RUN_LIMIT_PER_TECH;
  if (raw == null || raw === '') return DEFAULT_DAILY_RUN_LIMIT_PER_TECH;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100000) return DEFAULT_DAILY_RUN_LIMIT_PER_TECH;
  return n;
}

export function validateIdentifyRequest(body: unknown): { ok: true; openingId: string; photoIds: string[]; clientRequestId: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_hardware_recognition_request' };
  const row = body as Record<string, unknown>;
  const allowed = new Set(['opening_id', 'photo_ids', 'client_request_id']);
  if (Object.keys(row).some((key) => !allowed.has(key))) return { ok: false, error: 'invalid_hardware_recognition_request' };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof row.opening_id !== 'string' || !uuid.test(row.opening_id)) return { ok: false, error: 'invalid_hardware_recognition_request' };
  if (typeof row.client_request_id !== 'string' || !uuid.test(row.client_request_id)) return { ok: false, error: 'invalid_hardware_recognition_request' };
  if (!Array.isArray(row.photo_ids) || row.photo_ids.some((id) => typeof id !== 'string' || !uuid.test(id))) return { ok: false, error: 'invalid_hardware_recognition_request' };
  const count = photoCountError(row.photo_ids.length);
  if (count) return { ok: false, error: count };
  if (new Set(row.photo_ids).size !== row.photo_ids.length) return { ok: false, error: 'duplicate_photo' };
  return { ok: true, openingId: row.opening_id, photoIds: row.photo_ids, clientRequestId: row.client_request_id };
}

export function workflowRequestBytes(imageBase64: string[], apiKeyLength = 32): number {
  const images = imageBase64.map((value) => ({ type: 'base64', value }));
  return Buffer.byteLength(JSON.stringify({ api_key: 'k'.repeat(Math.max(0, apiKeyLength)), inputs: { images } }));
}

type SharpFactory = (input: Buffer) => {
  rotate: () => any;
  resize: (options: object) => any;
  jpeg: (options: object) => any;
  toBuffer: () => Promise<Buffer>;
};

const COMPRESS_STEPS = [
  { max: 1600, quality: 75 },
  { max: 1280, quality: 65 },
  { max: 1024, quality: 55 },
  { max: 800, quality: 45 },
];

export async function compressForWorkflow(
  inputs: Uint8Array[],
  options: { budget?: number; apiKeyLength?: number; sharp?: SharpFactory } = {},
): Promise<{ images: WorkflowImage[]; sentBytes: number[] }> {
  const budget = options.budget ?? WORKFLOW_REQUEST_BYTE_BUDGET;
  const pack = (list: Uint8Array[]) => {
    const images = list.map((bytes) => ({ type: 'base64' as const, value: Buffer.from(bytes).toString('base64') }));
    return { images, sentBytes: list.map((bytes) => bytes.byteLength), bytes: workflowRequestBytes(images.map((image) => image.value), options.apiKeyLength) };
  };
  const original = pack(inputs);
  if (original.bytes <= budget) return { images: original.images, sentBytes: original.sentBytes };
  let sharp = options.sharp;
  if (!sharp) {
    try {
      // Variable specifier keeps the native module out of the function bundle, matching recognition downscale.
      const name = 'sharp';
      const mod: any = await import(name);
      sharp = (mod.default ?? mod) as SharpFactory;
    } catch {
      throw new Error('photos_exceed_provider_limit');
    }
  }
  for (const step of COMPRESS_STEPS) {
    const next: Uint8Array[] = [];
    for (const input of inputs) {
      const out = await sharp!(Buffer.from(input)).rotate()
        .resize({ width: step.max, height: step.max, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: step.quality, mozjpeg: true })
        .toBuffer();
      next.push(new Uint8Array(out));
    }
    const packed = pack(next);
    if (packed.bytes <= budget) return { images: packed.images, sentBytes: packed.sentBytes };
  }
  throw new Error('photos_exceed_provider_limit');
}

export function publicRun(run: StoredRun) {
  return {
    id: run.id,
    opening_id: run.opening_id,
    status: run.status,
    failure_code: run.failure_code,
    photo_count: run.photo_count,
    items: run.items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      hardware_type: item.hardware_type,
      component_type: item.component_type,
      subtype: item.subtype,
      manufacturer: item.manufacturer,
      exact_model: item.exact_model,
      finish: item.finish,
      supporting_photos: item.supporting_photos,
      visible_evidence: item.visible_evidence,
      confidence: item.confidence,
      next_photo: item.next_photo,
      model_unknown: item.model_unknown,
      review_state: item.review_state,
      hardware_component_id: item.hardware_component_id,
    })),
  };
}

export type ConfirmDecision = {
  id: string;
  include: boolean;
  component_type: string;
  subtype?: string | null;
  manufacturer?: string | null;
  model_number?: string | null;
  finish?: string | null;
};

export type ConfirmationPlan = {
  hardware: {
    itemId: string;
    component_type: ComponentType;
    subtype: string | null;
    manufacturer: string | null;
    model_number: string | null;
    finish: string | null;
    notes: string;
    identity_status: 'established' | 'unresolved';
  }[];
  labels: {
    itemId: string;
    photoId: string;
    photoOrdinal: number;
    component_type: ComponentType;
    subtype: string | null;
    manufacturer: string | null;
    model_number: string | null;
    finish: string | null;
    confidence: string | null;
    visible_evidence: string | null;
    label: Record<string, unknown>;
  }[];
  itemUpdates: { itemId: string; review_state: 'confirmed' | 'dismissed'; component_type: ComponentType; subtype: string | null; manufacturer: string | null; model_number: string | null; finish: string | null }[];
  singlePhotoLinks: { photoId: string; itemId: string }[];
};

const clean = (value: string | null | undefined, max: number) => text(value ?? null, max);

export function planConfirmation(run: StoredRun, decisions: ConfirmDecision[]): { ok: true; plan: ConfirmationPlan } | { ok: false; error: string } {
  if (decisions.length !== run.items.length) return { ok: false, error: 'invalid_confirmation' };
  const byId = new Map<string, ConfirmDecision>();
  for (const decision of decisions) {
    if (byId.has(decision.id)) return { ok: false, error: 'invalid_confirmation' };
    byId.set(decision.id, decision);
  }
  const photoByOrdinal = new Map(run.photos.map((photo) => [photo.ordinal, photo.photo_id]));
  const plan: ConfirmationPlan = { hardware: [], labels: [], itemUpdates: [], singlePhotoLinks: [] };
  const cited = new Map<string, string[]>();
  for (const item of run.items) {
    const decision = byId.get(item.id);
    if (!decision) return { ok: false, error: 'invalid_confirmation' };
    const component = mapHardwareType(decision.component_type);
    if (component === 'other' && decision.component_type.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/ /g, '_') !== 'other') {
      return { ok: false, error: 'invalid_component_type' };
    }
    const subtype = clean(decision.subtype, 200);
    const manufacturer = clean(decision.manufacturer, 200);
    const model = clean(decision.model_number, 200);
    const finish = clean(decision.finish, 80);
    plan.itemUpdates.push({ itemId: item.id, review_state: decision.include ? 'confirmed' : 'dismissed', component_type: component, subtype, manufacturer, model_number: model, finish });
    if (!decision.include) continue;
    const evidence = item.visible_evidence ? `Evidence: ${item.visible_evidence}` : null;
    const confidence = item.confidence ? `Confidence: ${item.confidence}.` : null;
    const notes = ['Identified from door photographs.', evidence, confidence].filter(Boolean).join(' ').slice(0, 2000);
    plan.hardware.push({
      itemId: item.id, component_type: component, subtype, manufacturer, model_number: model, finish, notes,
      identity_status: model ? 'established' : 'unresolved',
    });
    for (const ordinal of item.supporting_photos) {
      const photoId = photoByOrdinal.get(ordinal);
      if (!photoId) continue;
      plan.labels.push({
        itemId: item.id, photoId, photoOrdinal: ordinal, component_type: component, subtype, manufacturer,
        model_number: model, finish, confidence: item.confidence, visible_evidence: item.visible_evidence,
        label: {
          hardware_type: item.hardware_type, component_type: component, subtype, manufacturer,
          exact_model: model, finish, confidence: item.confidence, visible_evidence: item.visible_evidence,
          photo_ordinal: ordinal, next_photo: item.model_unknown ? item.next_photo : null,
        },
      });
      const list = cited.get(photoId) ?? [];
      list.push(item.id);
      cited.set(photoId, list);
    }
  }
  for (const [photoId, itemIds] of cited) {
    if (itemIds.length === 1) plan.singlePhotoLinks.push({ photoId, itemId: itemIds[0] });
  }
  return { ok: true, plan };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

async function postWorkflow(fetchImpl: FetchLike, apiKey: string, images: WorkflowImage[]): Promise<{ status: number; raw: unknown | undefined }> {
  const response = await fetchImpl(DOOR_HARDWARE_WORKFLOW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ api_key: apiKey, inputs: { images } }),
    signal: AbortSignal.timeout(50_000),
  });
  const textBody = await response.text();
  let json: unknown;
  try { json = JSON.parse(textBody); } catch { return { status: response.status, raw: undefined }; }
  const taken = takeCombinedHardware(json);
  return { status: response.status, raw: taken.ok ? taken.raw : undefined };
}

export async function executeIdentify(
  actor: { organizationId: string; userId: string },
  input: { openingId: string; photoIds: string[]; clientRequestId: string },
  deps: { store: DoorHardwareStore; fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv; compress?: typeof compressForWorkflow },
): Promise<Outcome> {
  const store = deps.store;
  const env = deps.env ?? process.env;
  const countError = photoCountError(input.photoIds.length);
  if (countError) return { httpStatus: 400, body: { error: countError } };
  if (new Set(input.photoIds).size !== input.photoIds.length) return { httpStatus: 400, body: { error: 'duplicate_photo' } };
  const opening = await store.findOpening(actor.organizationId, input.openingId);
  if (!opening) return { httpStatus: 404, body: { error: 'opening_not_found' } };
  if (!(await store.areaAllows(actor.userId, input.openingId))) return { httpStatus: 403, body: { error: 'forbidden' } };
  const prior = await store.findRunByRequest(actor.userId, input.clientRequestId);
  if (prior) {
    const existing = await store.findRun(actor.organizationId, prior.id);
    if (!existing || prior.organization_id !== actor.organizationId) return { httpStatus: 409, body: { error: 'client_request_id_in_use' } };
    if (!(await store.areaAllows(actor.userId, existing.opening_id))) return { httpStatus: 403, body: { error: 'forbidden' } };
    return { httpStatus: 200, body: { run: publicRun(existing), replayed: true } };
  }
  const apiKey = env.ROBOFLOW_API_KEY;
  if (!apiKey) return { httpStatus: 503, body: { error: 'hardware_recognition_unavailable' } };

  const photos = await store.loadPhotos(actor.organizationId, input.openingId, input.photoIds);
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  if (input.photoIds.some((id) => !byId.has(id))) return { httpStatus: 404, body: { error: 'stored_photo_not_found' } };
  const ordered = input.photoIds.map((id) => byId.get(id)!);
  if (ordered.some((photo) => !MEDIA.has(photo.content_type))) return { httpStatus: 400, body: { error: 'unsupported_photo_type' } };

  const inserted = await store.insertRun({
    organizationId: actor.organizationId, propertyId: opening.property_id, openingId: input.openingId,
    userId: actor.userId, clientRequestId: input.clientRequestId, photoCount: ordered.length,
  });
  if (!inserted.created) {
    const existing = await store.findRun(actor.organizationId, inserted.id);
    return existing ? { httpStatus: 200, body: { run: publicRun(existing), replayed: true } } : { httpStatus: 409, body: { error: 'client_request_id_in_use' } };
  }
  const fail = async (status: string, failure_code: string, httpStatus: number, provider_called = false): Promise<Outcome> => {
    await store.finishRun(inserted.id, { status, failure_code, provider_called });
    const run = await store.findRun(actor.organizationId, inserted.id);
    return { httpStatus, body: { error: failure_code, run: run ? publicRun(run) : undefined } };
  };

  const originals: Uint8Array[] = [];
  try {
    for (const photo of ordered) {
      const bytes = await store.readBytes(photo.storage_object_key);
      if (sha256Hex(bytes) !== photo.sha256_checksum) return fail('failed', 'stored_original_checksum_mismatch', 422);
      originals.push(bytes);
    }
  } catch {
    return fail('failed', 'stored_original_unreadable', 422);
  }

  let prepared: { images: WorkflowImage[]; sentBytes: number[] };
  try {
    prepared = await (deps.compress ?? compressForWorkflow)(originals, { apiKeyLength: apiKey.length });
  } catch {
    return fail('failed', 'photos_exceed_provider_limit', 413);
  }
  await store.attachPhotos(inserted.id, ordered.map((photo, index) => ({
    photoId: photo.id, ordinal: index + 1, sha256: photo.sha256_checksum, sentBytes: prepared.sentBytes[index] ?? 0,
  })));

  const techLimit = resolveTechDailyLimit(env);
  const companyLimit = await store.orgDailyLimit(actor.organizationId);
  if (!(await store.consumeDailyRun(actor.organizationId, actor.userId, techLimit, companyLimit))) return fail('refused', 'daily_limit_exceeded', 429);

  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  let providerCalled = false;
  try {
    providerCalled = true;
    let attempt = await postWorkflow(fetchImpl, apiKey, prepared.images);
    const parsedFirst = attempt.status === 200 ? parseCombinedHardware(attempt.raw) : null;
    if (attempt.status === 200 && !parsedFirst?.ok) {
      attempt = await postWorkflow(fetchImpl, apiKey, prepared.images);
    }
    if (attempt.status !== 200) {
      const ambiguous = attempt.status >= 500;
      return fail(ambiguous ? 'ambiguous' : 'failed', ambiguous ? 'provider_call_outcome_unknown' : 'provider_rejected', ambiguous ? 503 : 502, true);
    }
    const parsed = parseCombinedHardware(attempt.raw);
    if (!parsed.ok) return fail('failed', 'provider_result_unreadable', 502, true);
    await store.insertItems(inserted.id, parsed.items);
    await store.finishRun(inserted.id, { status: 'pending_review', result: { items: parsed.items }, provider_called: true });
    const run = await store.findRun(actor.organizationId, inserted.id);
    return { httpStatus: 201, body: { run: run ? publicRun(run) : null } };
  } catch {
    return fail(providerCalled ? 'ambiguous' : 'failed', providerCalled ? 'provider_call_outcome_unknown' : 'internal_error', 503, providerCalled);
  }
}

export async function executeConfirm(
  actor: { organizationId: string; userId: string },
  runId: string,
  decisions: ConfirmDecision[],
  store: DoorHardwareStore,
): Promise<Outcome> {
  const run = await store.findRun(actor.organizationId, runId);
  if (!run || run.organization_id !== actor.organizationId) return { httpStatus: 404, body: { error: 'not_found' } };
  if (!(await store.areaAllows(actor.userId, run.opening_id))) return { httpStatus: 403, body: { error: 'forbidden' } };
  if (run.status === 'confirmed') return { httpStatus: 200, body: { run: publicRun(run), replayed: true } };
  if (run.status !== 'pending_review') return { httpStatus: 409, body: { error: 'run_not_awaiting_review' } };
  const planned = planConfirmation(run, decisions);
  if (!planned.ok) return { httpStatus: 400, body: { error: planned.error } };
  const saved = await store.confirm(actor, runId, planned.plan);
  const fresh = await store.findRun(actor.organizationId, runId);
  if (saved.already) return { httpStatus: 200, body: { run: fresh ? publicRun(fresh) : publicRun(run), replayed: true } };
  return { httpStatus: 200, body: { run: fresh ? publicRun(fresh) : publicRun(run), hardware_components: saved.hardware, training_labels: saved.training_labels } };
}
