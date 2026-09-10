import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

interface QaRecord {
  verdict: 'PASS' | 'FAIL' | 'HOLD';
  visible_geometry_match: boolean;
  source_fidelity_match: boolean;
  identity_ambiguity: boolean;
  unexplained_added_features: boolean;
  view_type_match: boolean;
  reasons: string[];
  qa_model: string;
  qa_at: string;
}

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
  candidate_sha256?: string;
  qa?: QaRecord;
}

interface RequestDocument {
  schema_version: string;
  requests: ImageRequest[];
}

const [workingDirectoryArg, allowedRootArg, manufacturerGroup] = process.argv.slice(2);
if (!workingDirectoryArg || !allowedRootArg || !manufacturerGroup) {
  throw new Error('Usage: imageQaCli <workingDirectory> <allowedRoot> <manufacturerGroup>');
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required for visual QA.');

const workingDirectory = resolve(workingDirectoryArg);
const allowedRoot = resolve(workingDirectory, allowedRootArg);
const requestPath = resolve(allowedRoot, 'UNATTENDED_IMAGE_REQUESTS.json');
const model = process.env.OI_IMAGE_QA_MODEL ?? 'gpt-5.6-sol';
const maxQa = Math.max(0, Number.parseInt(process.env.OI_MAX_IMAGE_QA_PER_LANE_CYCLE ?? '2', 10) || 2);

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

function readDataUrl(repoPath: string): string | null {
  if (!insideAllowedRoot(repoPath)) return null;
  const absolute = resolve(workingDirectory, repoPath);
  const mime = imageMime(absolute);
  if (!mime || !existsSync(absolute)) return null;
  const bytes = readFileSync(absolute);
  if (bytes.byteLength > 20 * 1024 * 1024) return null;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function extractOutputText(payload: Record<string, unknown>): string | null {
  const output = payload.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return null;
}

async function performQa(request: ImageRequest, candidate: string, sources: string[]): Promise<QaRecord> {
  const content: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: [
        'You are the Opening Intelligence canonical hardware visual QA gate.',
        `Manufacturer group: ${request.manufacturer_group}`,
        `Exact canonical identity: ${request.canonical_product_id}`,
        `Required view: ${request.view_type}`,
        `Governed generation brief: ${request.prompt}`,
        'Image 1 is the generated candidate. Remaining images are exact manufacturer/source evidence supplied by the governed lane.',
        'Judge only visible geometry and source fidelity. Do not infer hidden geometry, identity, dimensions, or features that the evidence does not show.',
        'PASS only when the candidate visibly matches the supplied evidence/configuration, depicts the requested view, contains no unexplained product features, and has no meaningful identity ambiguity.',
        'Use HOLD when evidence is inadequate for a defensible pass. Use FAIL for a visible mismatch.',
      ].join('\n'),
    },
    { type: 'input_image', image_url: candidate, detail: 'high' },
    ...sources.map((image_url) => ({ type: 'input_image', image_url, detail: 'high' })),
  ];

  const schema = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['PASS', 'FAIL', 'HOLD'] },
      visible_geometry_match: { type: 'boolean' },
      source_fidelity_match: { type: 'boolean' },
      identity_ambiguity: { type: 'boolean' },
      unexplained_added_features: { type: 'boolean' },
      view_type_match: { type: 'boolean' },
      reasons: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'verdict',
      'visible_geometry_match',
      'source_fidelity_match',
      'identity_ambiguity',
      'unexplained_added_features',
      'view_type_match',
      'reasons',
    ],
    additionalProperties: false,
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'medium' },
      store: false,
      input: [{ role: 'user', content }],
      text: {
        format: {
          type: 'json_schema',
          name: 'opening_intelligence_image_qa',
          strict: true,
          schema,
        },
      },
    }),
  });

  const payload = await response.json() as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `RESPONSES_API_HTTP_${response.status}`);
  const text = extractOutputText(payload);
  if (!text) throw new Error('VISUAL_QA_RETURNED_NO_TEXT');
  const qa = JSON.parse(text) as Omit<QaRecord, 'qa_model' | 'qa_at'>;
  return { ...qa, qa_model: model, qa_at: new Date().toISOString() };
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
  let checked = 0;
  let passed = 0;

  for (const request of document.requests) {
    if (checked >= maxQa) break;
    if (request.status !== 'CANDIDATE_GENERATED_UNVERIFIED' && request.status !== 'QA_RETRY') continue;
    if (request.manufacturer_group !== manufacturerGroup) continue;

    const candidate = readDataUrl(request.candidate_path);
    const sources = (request.source_evidence_paths ?? [])
      .map(readDataUrl)
      .filter((value): value is string => Boolean(value))
      .slice(0, 8);

    if (!candidate) {
      request.status = 'QA_CONTROLLED_HOLD';
      request.qa = {
        verdict: 'HOLD',
        visible_geometry_match: false,
        source_fidelity_match: false,
        identity_ambiguity: true,
        unexplained_added_features: false,
        view_type_match: false,
        reasons: ['Candidate image is missing or unreadable.'],
        qa_model: model,
        qa_at: new Date().toISOString(),
      };
      checked += 1;
      writeDocumentAtomic(document);
      continue;
    }

    if (sources.length === 0) {
      request.status = 'QA_CONTROLLED_HOLD';
      request.qa = {
        verdict: 'HOLD',
        visible_geometry_match: false,
        source_fidelity_match: false,
        identity_ambiguity: true,
        unexplained_added_features: false,
        view_type_match: false,
        reasons: ['No exact source image is available for unattended source-fidelity QA.'],
        qa_model: model,
        qa_at: new Date().toISOString(),
      };
      checked += 1;
      writeDocumentAtomic(document);
      continue;
    }

    try {
      const qa = await performQa(request, candidate, sources);
      request.qa = qa;
      if (
        qa.verdict === 'PASS' &&
        qa.visible_geometry_match &&
        qa.source_fidelity_match &&
        qa.view_type_match &&
        !qa.identity_ambiguity &&
        !qa.unexplained_added_features
      ) {
        request.status = 'QA_PASSED_CANDIDATE_NOT_CANONICAL';
        passed += 1;
      } else if (qa.verdict === 'FAIL') {
        request.status = 'QA_REJECTED';
      } else {
        request.status = 'QA_CONTROLLED_HOLD';
      }
    } catch (error) {
      request.status = 'QA_RETRY';
      request.qa = {
        verdict: 'HOLD',
        visible_geometry_match: false,
        source_fidelity_match: false,
        identity_ambiguity: true,
        unexplained_added_features: false,
        view_type_match: false,
        reasons: [`Visual QA API error: ${(error as Error).message.slice(0, 800)}`],
        qa_model: model,
        qa_at: new Date().toISOString(),
      };
    }

    checked += 1;
    writeDocumentAtomic(document);
  }

  writeDocumentAtomic(document);
  console.log(JSON.stringify({ checked, passed, qa_model: model }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
