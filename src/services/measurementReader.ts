import { DEFAULT_CLAUDE_MODEL, postAnthropicMessages } from "./anthropicMessages";

export const MEASUREMENT_FIELDS = ["frame_width", "frame_height", "active_width", "active_height", "inactive_width", "inactive_height"] as const;
export type MeasurementField = typeof MEASUREMENT_FIELDS[number];

export type MeasurementSuggestion = {
  field: MeasurementField;
  inches: number;
  confidence: number;
  bounds: string;
};

export class MeasurementReaderError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "MeasurementReaderError";
    this.status = status;
  }
}

/** Sample Apple Measure style reading. Tests use this. It is not written to an opening. */
export const SAMPLE_MEASUREMENT_SUGGESTIONS: MeasurementSuggestion[] = [
  { field: "frame_width", inches: 72, confidence: 0.86, bounds: "Outer frame width along the top of the Measure card" },
  { field: "frame_height", inches: 96, confidence: 0.84, bounds: "Outer frame height along the left of the Measure card" },
  { field: "active_width", inches: 36, confidence: 0.8, bounds: "Active leaf width" },
  { field: "active_height", inches: 84, confidence: 0.81, bounds: "Active leaf height" },
  { field: "inactive_width", inches: 30, confidence: 0.62, bounds: "Inactive leaf width" },
  { field: "inactive_height", inches: 84, confidence: 0.7, bounds: "Inactive leaf height" },
];

const EDGE_TO_FIELD: Record<string, MeasurementField> = {
  "frame width": "frame_width",
  "frame height": "frame_height",
  "active leaf width": "active_width",
  "active leaf height": "active_height",
  "inactive leaf width": "inactive_width",
  "inactive leaf height": "inactive_height",
};

export const MEASUREMENT_PROMPT = [
  "You are reading one Apple Measure screenshot of a commercial door and its frame.",
  "Transcribe only measurements that are visibly printed on the screenshot. Do not estimate a size that is not shown.",
  "For each visible measurement, say the label text exactly as printed, the value in decimal inches, which edge it belongs to, and your confidence from 0 to 1.",
  "The edge must be one of: frame width, frame height, active leaf width, active leaf height, inactive leaf width, inactive leaf height.",
  "A pair has an active leaf and an inactive leaf. A single door has one leaf; call that leaf the active leaf. The frame is the outer opening.",
  "Return ONLY compact JSON, no prose, in exactly this shape:",
  '{"dimensions":[{"label":"<printed text>","inches":<number>,"edge":"<one edge name>","confidence":<0-1>}]}',
  "Omit any edge you cannot see. An empty dimensions array is correct when the screenshot shows no measurement.",
].join("\n");

export interface MeasurementProvider {
  name: string;
  read(image: { contentType: string; bytes: Buffer }): Promise<MeasurementSuggestion[]>;
}

const mockProvider: MeasurementProvider = {
  name: "mock",
  async read() { return SAMPLE_MEASUREMENT_SUGGESTIONS; },
};

const READABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function measurementImageType(contentType: string): string | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return READABLE_IMAGE_TYPES.has(type) ? type : null;
}

/** Prose that names a size, such as "six feet" or 3' 11", is not an empty reading. */
const CLAIMS_PRINTED_SIZE = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[\s\S]{0,16}\b(?:feet|foot|ft|inch|inches|in)\b|\d\s*['′″"]/i;

export function parseMeasurementText(text: string): MeasurementSuggestion[] {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) {
    if (!CLAIMS_PRINTED_SIZE.test(text)) return [];
    throw new MeasurementReaderError("measurement_response_unreadable", 502);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(first, last + 1)); }
  catch { throw new MeasurementReaderError("measurement_response_unreadable", 502); }
  const dimensions = parsed && typeof parsed === "object" ? (parsed as { dimensions?: unknown }).dimensions : undefined;
  if (!Array.isArray(dimensions)) throw new MeasurementReaderError("measurement_response_unreadable", 502);
  return dimensions.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as { label?: unknown; inches?: unknown; edge?: unknown; confidence?: unknown };
    const field = EDGE_TO_FIELD[String(item.edge ?? "").trim().toLowerCase()];
    const inches = Number(item.inches);
    const confidence = Number(item.confidence);
    if (!field || !Number.isFinite(inches) || inches <= 0 || !Number.isFinite(confidence)) return [];
    const label = String(item.label ?? "").trim();
    return [{ field, inches, confidence: Math.max(0, Math.min(1, confidence)), bounds: label ? `${String(item.edge).trim()}: ${label}` : String(item.edge).trim() }];
  });
}

export function measurementAnthropicFailureCode(status: number): string {
  if (status === 401 || status === 403) return "measurement_reader_auth";
  if (status === 429) return "measurement_reader_rate_limited";
  if (status === 529 || status >= 500) return "measurement_reader_overloaded";
  if (status === 400 || status === 404 || status === 413) return "measurement_reader_rejected";
  return "measurement_reader_failed";
}

function scrubProviderText(value: string, secret: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const hidden = secret ? compact.split(secret).join("[redacted]") : compact;
  return hidden
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

function logAnthropicFailure(detail: {
  status: number;
  errorType: string;
  errorMessage: string;
  requestId: string;
  model: string;
  imageBytes: number;
  mediaType: string;
  durationMs: number;
  secret: string;
}) {
  console.error(JSON.stringify({
    event: "measurement_reader_anthropic",
    status: detail.status,
    errorType: scrubProviderText(detail.errorType, detail.secret),
    errorMessage: scrubProviderText(detail.errorMessage, detail.secret),
    requestId: scrubProviderText(detail.requestId, detail.secret),
    model: scrubProviderText(detail.model, detail.secret),
    imageBytes: detail.imageBytes,
    mediaType: scrubProviderText(detail.mediaType, detail.secret),
    durationMs: detail.durationMs,
  }));
}

function anthropicProvider(): MeasurementProvider {
  return {
    name: "anthropic",
    async read(image) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (process.env.OI_RECOGNITION_ENABLED !== "true" || !key) throw new MeasurementReaderError("measurement_reader_unconfigured");
      const mediaType = measurementImageType(image.contentType || "");
      if (!mediaType) throw new MeasurementReaderError("measurement_image_type", 400);
      const model = process.env.OI_MEASUREMENT_READER_MODEL || DEFAULT_CLAUDE_MODEL;
      const started = Date.now();
      let response: Response;
      try {
        response = await postAnthropicMessages({
          apiKey: key,
          model,
          maxTokens: 1200,
          images: [{ mediaType, data: image.bytes.toString("base64") }],
          text: MEASUREMENT_PROMPT,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") throw new MeasurementReaderError("measurement_reader_timeout", 504);
        throw new MeasurementReaderError("measurement_network", 502);
      }
      const raw = await response.text();
      let body: { content?: { text?: string }[]; error?: { type?: string; message?: string } } | null = null;
      let parsed = false;
      try {
        body = raw ? JSON.parse(raw) : {};
        parsed = true;
      } catch { body = null; }
      if (!response.ok || !parsed || !body) {
        const errorType = body?.error && typeof body.error.type === "string" ? body.error.type : "";
        const errorMessage = body?.error && typeof body.error.message === "string" ? body.error.message : "";
        logAnthropicFailure({
          status: response.status,
          errorType,
          errorMessage,
          requestId: response.headers.get("request-id") || "",
          model,
          imageBytes: image.bytes.length,
          mediaType,
          durationMs: Date.now() - started,
          secret: key,
        });
        const code = response.ok ? "measurement_reader_failed" : measurementAnthropicFailureCode(response.status);
        throw new MeasurementReaderError(code, 502);
      }
      return parseMeasurementText(body.content?.[0]?.text || "");
    },
  };
}

export function measurementProvider(name = process.env.OI_MEASUREMENT_READER || ""): MeasurementProvider {
  if (name === "mock") return mockProvider;
  if (name === "anthropic") return anthropicProvider();
  throw new MeasurementReaderError("measurement_reader_not_selected");
}

export function measurementReadingAllowed(recognitionFeaturesEnabled: boolean): boolean {
  return recognitionFeaturesEnabled !== false;
}
