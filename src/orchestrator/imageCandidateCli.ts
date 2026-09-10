import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

interface ImageRequest {
  request_id: string;
  status: string;
  canonical_product_id: string;
  manufacturer_group: string;
  view_type: string;
  prompt: string;
  candidate_path: string;
  final_path?: string;
  identity_lock_state: string;
  view_geometry_lock_state: string;
  source_evidence_paths?: string[];
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  generated_at?: string;
  image_model?: string;
  candidate_sha256?: string;
  generation_error?: string;
  generation_attempts?: number;
}

interface RequestDocument {
  schema_version: string;
  requests: ImageRequest[];
}

interface SourceImage {
  bytes: Buffer;
  mime: string;
  filename: string;
}

class ImageApiError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ImageApiError';
    this.retryable = retryable;
  }
}

const [workingDirectoryArg, allowedRootArg, manufacturerGroup] = process.argv.slice(2);
if (!workingDirectoryArg || !allowedRootArg || !manufacturerGroup) {
  throw new Error('Usage: imageCandidateCli <workingDirectory> <allowedRoot> <manufacturerGroup>');
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required for image candidate generation.');

const workingDirectory = resolve(workingDirectoryArg);
const allowedRoot = resolve(workingDirectory, allowedRootArg);
const requestPath = resolve(allowedRoot, 'UNATTENDED_IMAGE_REQUESTS.json');
const maxImages = Math.max(0, Number.parseInt(process.env.OI_MAX_IMAGES_PER_LANE_CYCLE ?? '2', 10) || 2);
const model = process.env.OI_IMAGE_MODEL ?? 'gpt-image-2-2026-04-21';

function insideAllowedRoot(path: string): boolean {
  const resolved = resolve(workingDirectory, path);
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}/`);
}

function imageMime(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return null;
  }
}

function readSourceImage(repoPath: string): SourceImage | null {
  if (!insideAllowedRoot(repoPath)) return null;
  const absolute = resolve(workingDirectory, repoPath);
  const mime = imageMime(absolute);
  if (!mime || !existsSync(absolute)) return null;
  const bytes = readFileSync(absolute);
  if (bytes.byteLength > 20 * 1024 * 1024) return null;
  return { bytes, mime, filename: basename(absolute) };
}

function validateRequest(request: ImageRequest): string | null {
  if (request.manufacturer_group !== manufacturerGroup) return 'MANUFACTURER_SCOPE_MISMATCH';
  if (!/^LOCKED_EXACT(?:_|$)|^EXACT_IDENTITY_LOCKED$/.test(request.identity_lock_state)) return 'EXACT_IDENTITY_NOT_LOCKED';
  if (!/^VIEW_GEOMETRY_LOCKED$|^RELEASED_EXACT(?:_|$)/.test(request.view_geometry_lock_state)) return 'VIEW_GEOMETRY_NOT_LOCKED';
  if (!insideAllowedRoot(request.candidate_path)) return 'CANDIDATE_PATH_OUTSIDE_LANE';
  if (!request.candidate_path.includes('/artifacts/imagery-candidates/')) return 'CANDIDATE_PATH_NOT_ISOLATED';
  if (extname(request.candidate_path).toLowerCase() !== '.png') return 'CANDIDATE_MUST_BE_PNG';
  if (!request.prompt.trim()) return 'PROMPT_EMPTY';
  return null;
}

function isGenerationEligible(status: string): boolean {
  return status === 'READY_TO_GENERATE' || status === 'GENERATION_RETRY';
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function fidelityPrompt(request: ImageRequest): string {
  return [
    'Opening Intelligence controlled canonical hardware candidate.',
    `Exact manufacturer group: ${request.manufacturer_group}.`,
    `Exact canonical identity: ${request.canonical_product_id}.`,
    `Required view: ${request.view_type}.`,
    'Generate one isolated commercial door-hardware product on a clean white background.',
    'No text, labels, callouts, dimensions, watermarks, logos, hands, people, extra products, invented fasteners, or decorative additions.',
    'Preserve visible geometry, proportions, component placement, arm/rail/body relationships, finish behavior, and configuration from the supplied exact evidence.',
    'Do not borrow geometry from adjacent models or infer hidden features.',
    request.prompt.trim(),
  ].join('\n');
}

async function parseImageResponse(response: Response): Promise<Buffer> {
  const payload = await response.json() as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
  if (!response.ok) {
    throw new ImageApiError(
      payload.error?.message ?? `IMAGE_API_HTTP_${response.status}`,
      isRetryableHttpStatus(response.status),
    );
  }
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) throw new ImageApiError('IMAGE_API_RETURNED_NO_BASE64_IMAGE', true);
  return Buffer.from(encoded, 'base64');
}

async function callImageApi(request: ImageRequest): Promise<Buffer> {
  const sources = (request.source_evidence_paths ?? [])
    .map(readSourceImage)
    .filter((value): value is SourceImage => Boolean(value))
    .slice(0, 8);

  const prompt = fidelityPrompt(request);
  const size = request.size ?? '1536x1024';
  const quality = request.quality ?? 'medium';

  if (sources.length > 0) {
    // The Image edits endpoint accepts source files as multipart image[] parts.
    // GPT-Image-2 always processes image inputs at high fidelity; input_fidelity
    // must be omitted for this model snapshot.
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', size);
    form.append('quality', quality);
    form.append('output_format', 'png');
    form.append('background', 'opaque');
    for (const source of sources) {
      form.append('image[]', new Blob([new Uint8Array(source.bytes)], { type: source.mime }), source.filename);
    }

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    return parseImageResponse(response);
  }

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size,
      quality,
      output_format: 'png',
      background: 'opaque',
    }),
  });
  return parseImageResponse(response);
}

function writeDocumentAtomic(document: RequestDocument): void {
  const temp = `${requestPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(temp, requestPath);
}

async function main(): Promise<void> {
  if (!existsSync(requestPath)) {
    console.log('NO_UNATTENDED_IMAGE_REQUEST_FILE');
    return;
  }

  const document = JSON.parse(readFileSync(requestPath, 'utf8')) as RequestDocument;
  let generated = 0;
  let attempted = 0;

  for (const request of document.requests) {
    if (attempted >= maxImages) break;
    if (!isGenerationEligible(request.status)) continue;

    const validationError = validateRequest(request);
    if (validationError) {
      request.status = 'GENERATION_CONTROLLED_HOLD';
      request.generation_error = validationError;
      writeDocumentAtomic(document);
      continue;
    }

    request.generation_attempts = (request.generation_attempts ?? 0) + 1;
    attempted += 1;
    try {
      const image = await callImageApi(request);
      const absoluteCandidate = resolve(workingDirectory, request.candidate_path);
      mkdirSync(dirname(absoluteCandidate), { recursive: true });
      writeFileSync(absoluteCandidate, image);
      request.candidate_sha256 = createHash('sha256').update(image).digest('hex');
      request.generated_at = new Date().toISOString();
      request.image_model = model;
      request.generation_error = undefined;
      request.status = 'CANDIDATE_GENERATED_UNVERIFIED';
      generated += 1;
    } catch (error) {
      const message = (error as Error).message.slice(0, 1000);
      const retryable = error instanceof ImageApiError ? error.retryable : true;
      request.status = retryable ? 'GENERATION_RETRY' : 'GENERATION_CONTROLLED_HOLD';
      request.generation_error = message;
    }
    writeDocumentAtomic(document);
  }

  writeDocumentAtomic(document);
  console.log(JSON.stringify({ generated, attempted, request_file: requestPath, model }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
